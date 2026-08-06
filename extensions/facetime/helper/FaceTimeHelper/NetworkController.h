//
//  NetworkController.h
//  FaceTimeHelper
//
//  Created by Samer Shihabi on 11/20/20.
//  OpenClaw FaceTime helper.
//  Adapted and modified from the Apache-2.0 BlueBubbles helper.
//  See THIRD_PARTY_NOTICES.md.
//

#ifndef NetworkController_h
#define NetworkController_h
#import <Foundation/Foundation.h>

// Block typedefs
typedef void (^MessageBlock)(id,NSString*);

@interface NetworkController : NSObject<NSStreamDelegate>

// Singleton instance
+ (NetworkController*)sharedInstance;

// Methods
- (void)connect;
- (void)disconnect;
- (void)sendMessage:(NSDictionary*)message;

@property (copy) MessageBlock messageReceivedBlock;

@end
#endif /* NetworkController_h */
