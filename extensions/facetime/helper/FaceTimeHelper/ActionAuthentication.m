#import "ActionAuthentication.h"

#import <CommonCrypto/CommonHMAC.h>

static NSString *ActionHMAC(NSString *token, NSString *message) {
    NSData *key = [token dataUsingEncoding:NSUTF8StringEncoding];
    NSData *payload = [message dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CCHmac(kCCHmacAlgSHA256, key.bytes, key.length, payload.bytes, payload.length, digest);
    NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
        [hex appendFormat:@"%02x", digest[index]];
    }
    return hex;
}

static BOOL ActionAuthStringsEqual(NSString *first, NSString *second) {
    NSData *firstData = [first dataUsingEncoding:NSUTF8StringEncoding];
    NSData *secondData = [second dataUsingEncoding:NSUTF8StringEncoding];
    if (firstData.length == 0 || firstData.length != secondData.length) {
        return NO;
    }
    const unsigned char *firstBytes = firstData.bytes;
    const unsigned char *secondBytes = secondData.bytes;
    unsigned char difference = 0;
    for (NSUInteger index = 0; index < firstData.length; index++) {
        difference |= firstBytes[index] ^ secondBytes[index];
    }
    return difference == 0;
}

@implementation OpenClawFaceTimeActionAuthenticator {
    NSString *_token;
    NSString *_session;
    NSMutableSet<NSString *> *_acceptedNonces;
}

- (instancetype)initWithToken:(NSString *)token {
    self = [super init];
    if (self) {
        _token = [token copy];
        _session = @"";
        _acceptedNonces = [NSMutableSet set];
    }
    return self;
}

- (void)resetWithSession:(NSString *)session {
    @synchronized(self) {
        _session = [session copy];
        _acceptedNonces = [NSMutableSet set];
    }
}

- (OpenClawFaceTimeActionAuthResult)consumeAction:(NSString *)action
                                    transactionID:(NSString *)transactionID
                                           session:(NSString *)session
                                             nonce:(NSString *)nonce
                                          dataJSON:(NSString *)dataJSON
                                              auth:(NSString *)auth {
    @synchronized(self) {
        if (action.length == 0 || transactionID.length == 0 || session.length == 0 ||
            nonce.length == 0 || dataJSON.length == 0 || ![_session isEqualToString:session]) {
            return OpenClawFaceTimeActionAuthResultUnauthenticated;
        }
        NSString *payload = [NSString stringWithFormat:@"action\n%@\n%@\n%@\n%@\n%@",
            action, transactionID, session, nonce, dataJSON];
        if (!ActionAuthStringsEqual(auth, ActionHMAC(_token, payload))) {
            return OpenClawFaceTimeActionAuthResultUnauthenticated;
        }
        if ([_acceptedNonces containsObject:nonce]) {
            return OpenClawFaceTimeActionAuthResultReplay;
        }
        [_acceptedNonces addObject:nonce];
        return OpenClawFaceTimeActionAuthResultAccepted;
    }
}

@end
