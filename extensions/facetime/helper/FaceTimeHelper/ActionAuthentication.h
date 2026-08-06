#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, OpenClawFaceTimeActionAuthResult) {
    OpenClawFaceTimeActionAuthResultUnauthenticated,
    OpenClawFaceTimeActionAuthResultAccepted,
    OpenClawFaceTimeActionAuthResultReplay,
};

@interface OpenClawFaceTimeActionAuthenticator : NSObject

- (instancetype)initWithToken:(NSString *)token;
- (void)resetWithSession:(NSString *)session;
- (OpenClawFaceTimeActionAuthResult)consumeAction:(NSString *)action
                                    transactionID:(NSString *)transactionID
                                           session:(NSString *)session
                                             nonce:(NSString *)nonce
                                          dataJSON:(NSString *)dataJSON
                                              auth:(NSString *)auth;

@end
