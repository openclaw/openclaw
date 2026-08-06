//
//  NetworkController.m
//  FACETIMEHELPER
//
//  Created by Samer Shihabi on 11/20/20.
//  OpenClaw FaceTime helper.
//  Adapted and modified from the Apache-2.0 BlueBubbles helper.
//  See THIRD_PARTY_NOTICES.md.
//

#import <Foundation/Foundation.h>
#import "NetworkController.h"
#import "Logging.h"

static const NSUInteger OpenClawMaximumFrameBytes = 64 * 1024;

@interface NetworkController ()
@property (strong) NSInputStream *inputStream;
@property (strong) NSOutputStream *outputStream;
@property (strong) NSMutableData *readBuffer;
@property (strong) NSMutableData *writeBuffer;
@property NSUInteger writeOffset;
@property BOOL inputOpen;
@property BOOL outputOpen;
@property BOOL shouldReconnect;
@property NSUInteger connectionGeneration;
@end

@implementation NetworkController

@synthesize messageReceivedBlock;


#pragma mark - Singleton

static id sharedInstance = nil;

+ (void)initialize {
  if (self == [NetworkController class]) {
    sharedInstance = [[self alloc] init];
  }
}

+ (NetworkController*)sharedInstance {
  return sharedInstance;
}

#pragma mark - Public methods

#define CLAMP(x, low, high) ({\
  __typeof__(x) __x = (x); \
  __typeof__(low) __low = (low);\
  __typeof__(high) __high = (high);\
  __x > __high ? __high : (__x < __low ? __low : __x);\
  })

- (void)connect {
    self.shouldReconnect = YES;
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self connect];
        });
        return;
    }
    if (self.inputStream || self.outputStream) {
        return;
    }

    // we need to get the port to open the server on (to allow multiple users to use the bundle)
    // we'll base this off the users uid (a unique id for each user, starting from 501)
    // we'll subtract 501 to get an id starting at 0, incremented for each user
    // then we add this to the base port to get a unique port for the socket
    int port = CLAMP(45670 + getuid()-501, 45670, 65535);
    DLog("FACETIMEHELPER: Connecting to socket on port %{public}d", port);

    CFReadStreamRef readStream = NULL;
    CFWriteStreamRef writeStream = NULL;
    CFStreamCreatePairWithSocketToHost(
        kCFAllocatorDefault,
        (__bridge CFStringRef)@"127.0.0.1",
        (UInt32)port,
        &readStream,
        &writeStream
    );
    if (!readStream || !writeStream) {
        if (readStream) {
            CFRelease(readStream);
        }
        if (writeStream) {
            CFRelease(writeStream);
        }
        [self scheduleReconnect];
        return;
    }

    self.readBuffer = [NSMutableData data];
    self.writeBuffer = [NSMutableData data];
    self.writeOffset = 0;
    self.inputOpen = NO;
    self.outputOpen = NO;
    self.inputStream = CFBridgingRelease(readStream);
    self.outputStream = CFBridgingRelease(writeStream);
    self.inputStream.delegate = self;
    self.outputStream.delegate = self;
    [self.inputStream scheduleInRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    [self.outputStream scheduleInRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    [self.inputStream open];
    [self.outputStream open];
}

- (void)disconnect {
    self.shouldReconnect = NO;
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self disconnect];
        });
        return;
    }
    [self closeStreams];
}

- (void)sendMessage:(NSDictionary*)data {
    if (![NSThread isMainThread]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self sendMessage:data];
        });
        return;
    }
    NSError *error;
    NSData *jsonData = [NSJSONSerialization dataWithJSONObject:data options:0 error:&error];
    if (!jsonData) {
        DLog("FACETIMEHELPER: Failed to encode message: %{public}@", error);
        return;
    }
    NSString *message = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
    // add a newline to the message so back-to-back messages are split and sent correctly
    NSString *jsonMessage = [NSString stringWithFormat:(@"%@\r\n"), message];
    NSData* finalData = [jsonMessage dataUsingEncoding:NSUTF8StringEncoding];
    DLog("FACETIMEHELPER: Sending data: %{public}@", data);
    [self.writeBuffer appendData:finalData];
    [self flushWrites];
}

- (void)sendConnectedMessage {
    DLog("FACETIMEHELPER: Connected to gateway socket");
    NSDictionary *message = @{
        @"event": @"ping",
        @"message": @"Helper Connected!",
        @"bundle_identifier": [[NSBundle mainBundle] bundleIdentifier] ?: @"",
    };
    [self sendMessage:message];
}

- (void)flushWrites {
    if (!self.outputOpen || !self.outputStream.hasSpaceAvailable) {
        return;
    }
    while (self.writeOffset < self.writeBuffer.length && self.outputStream.hasSpaceAvailable) {
        const uint8_t *bytes = self.writeBuffer.bytes;
        NSInteger written = [self.outputStream
            write:bytes + self.writeOffset
            maxLength:self.writeBuffer.length - self.writeOffset];
        if (written < 0) {
            [self handleStreamFailure:self.outputStream.streamError];
            return;
        }
        if (written == 0) {
            return;
        }
        self.writeOffset += (NSUInteger)written;
    }
    if (self.writeOffset == self.writeBuffer.length) {
        [self.writeBuffer setLength:0];
        self.writeOffset = 0;
    }
}

- (void)readAvailableData {
    uint8_t bytes[4096];
    while (self.inputStream.hasBytesAvailable) {
        NSInteger count = [self.inputStream read:bytes maxLength:sizeof(bytes)];
        if (count < 0) {
            [self handleStreamFailure:self.inputStream.streamError];
            return;
        }
        if (count == 0) {
            break;
        }
        [self.readBuffer appendBytes:bytes length:(NSUInteger)count];
        [self drainReadBuffer];
        if (!self.inputStream) {
            return;
        }
    }
}

- (void)drainReadBuffer {
    while (true) {
        const uint8_t *buffer = self.readBuffer.bytes;
        NSUInteger newlineIndex = NSNotFound;
        for (NSUInteger index = 0; index < self.readBuffer.length; index++) {
            if (buffer[index] == '\n') {
                newlineIndex = index;
                break;
            }
        }
        if (newlineIndex == NSNotFound) {
            break;
        }
        NSUInteger lineLength = newlineIndex;
        if (lineLength > 0 && buffer[lineLength - 1] == '\r') {
            lineLength -= 1;
        }
        NSData *lineData = [self.readBuffer subdataWithRange:NSMakeRange(0, lineLength)];
        [self.readBuffer replaceBytesInRange:NSMakeRange(0, newlineIndex + 1)
                                   withBytes:NULL
                                      length:0];
        if (lineData.length == 0) {
            continue;
        }
        NSString *line = [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
        if (line && self.messageReceivedBlock) {
            DLog("FACETIMEHELPER: Received event: %{public}@", line);
            self.messageReceivedBlock(self, line);
        }
    }
    // The gateway protocol is newline framed and all valid helper messages are
    // small. Bound an incomplete frame so a rogue loopback server cannot grow
    // memory inside the injected FaceTime or Phone process without limit.
    if (self.readBuffer.length > OpenClawMaximumFrameBytes) {
        DLog("FACETIMEHELPER: Closing gateway socket after oversized frame");
        [self handleStreamFailure:nil];
    }
}

- (void)stream:(NSStream *)stream handleEvent:(NSStreamEvent)eventCode {
    switch (eventCode) {
        case NSStreamEventOpenCompleted:
            if (stream == self.inputStream) {
                self.inputOpen = YES;
            } else if (stream == self.outputStream) {
                self.outputOpen = YES;
            }
            if (self.inputOpen && self.outputOpen) {
                [self sendConnectedMessage];
                [self flushWrites];
            }
            break;
        case NSStreamEventHasBytesAvailable:
            [self readAvailableData];
            break;
        case NSStreamEventHasSpaceAvailable:
            [self flushWrites];
            break;
        case NSStreamEventErrorOccurred:
            [self handleStreamFailure:stream.streamError];
            break;
        case NSStreamEventEndEncountered:
            [self handleStreamFailure:nil];
            break;
        default:
            break;
    }
}

- (void)closeStreams {
    self.connectionGeneration += 1;
    for (NSStream *stream in @[self.inputStream ?: (NSStream *)NSNull.null,
                               self.outputStream ?: (NSStream *)NSNull.null]) {
        if ((id)stream == NSNull.null) {
            continue;
        }
        [stream close];
        [stream removeFromRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
        stream.delegate = nil;
    }
    self.inputStream = nil;
    self.outputStream = nil;
    self.inputOpen = NO;
    self.outputOpen = NO;
    self.readBuffer = nil;
    self.writeBuffer = nil;
    self.writeOffset = 0;
}

- (void)handleStreamFailure:(NSError *)error {
    if (!self.inputStream && !self.outputStream) {
        return;
    }
    DLog("FACETIMEHELPER: Gateway socket disconnected: %{public}@", error);
    [self closeStreams];
    [self scheduleReconnect];
}

- (void)scheduleReconnect {
    if (!self.shouldReconnect) {
        return;
    }
    NSUInteger generation = self.connectionGeneration;
    DLog("FACETIMEHELPER: Attempting to reconnect in 5 seconds");
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC),
                   dispatch_get_main_queue(), ^{
        if (self.shouldReconnect &&
            generation == self.connectionGeneration &&
            !self.inputStream &&
            !self.outputStream) {
            [self connect];
        }
    });
}

@end
