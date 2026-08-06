#import <CommonCrypto/CommonHMAC.h>
#import <Foundation/Foundation.h>

#import "../FaceTimeHelper/ActionAuthentication.h"

static NSString *TestHMAC(NSString *token, NSString *message) {
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

static OpenClawFaceTimeActionAuthResult Consume(
    OpenClawFaceTimeActionAuthenticator *authenticator,
    NSString *token,
    NSString *session,
    NSString *nonce
) {
    NSString *payload = [NSString stringWithFormat:@"action\nstart-call\ntx-1\n%@\n%@\n{}",
        session, nonce];
    return [authenticator
        consumeAction:@"start-call"
        transactionID:@"tx-1"
        session:session
        nonce:nonce
        dataJSON:@"{}"
        auth:TestHMAC(token, payload)];
}

int main(void) {
    @autoreleasepool {
        NSString *token = [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0];
        OpenClawFaceTimeActionAuthenticator *authenticator =
            [[OpenClawFaceTimeActionAuthenticator alloc] initWithToken:token];

        [authenticator resetWithSession:@"session-1"];
        NSCAssert(
            Consume(authenticator, token, @"session-1", @"nonce-1") ==
                OpenClawFaceTimeActionAuthResultAccepted,
            @"first authenticated action must be accepted"
        );
        NSCAssert(
            Consume(authenticator, token, @"session-1", @"nonce-1") ==
                OpenClawFaceTimeActionAuthResultReplay,
            @"same-session nonce replay must be rejected"
        );

        [authenticator resetWithSession:@"session-2"];
        NSCAssert(
            Consume(authenticator, token, @"session-1", @"nonce-2") ==
                OpenClawFaceTimeActionAuthResultUnauthenticated,
            @"prior-session envelope must be rejected after reconnect"
        );
        NSCAssert(
            Consume(authenticator, token, @"session-2", @"nonce-1") ==
                OpenClawFaceTimeActionAuthResultAccepted,
            @"a nonce belongs to its authenticated session"
        );
    }
    return 0;
}
