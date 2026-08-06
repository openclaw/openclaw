// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUANSWERREQUEST_H
#define TUANSWERREQUEST_H

@class NSDate, NSString, IDSDestination;

#import <Foundation/Foundation.h>

@interface TUAnswerRequest : NSObject



@property (nonatomic) BOOL allowBluetoothAnswerWithoutDowngrade; // ivar: _allowBluetoothAnswerWithoutDowngrade
@property (nonatomic) NSInteger behavior; // ivar: _behavior
@property (retain, nonatomic) NSDate *dateAnswered; // ivar: _dateAnswered
@property (readonly, copy) NSString *debugDescription;
@property (readonly, copy) NSString *description;
@property (nonatomic) BOOL downgradeToAudio; // ivar: _downgradeToAudio
@property (retain, nonatomic) IDSDestination *endpointIDSDestination; // ivar: _endpointIDSDestination
@property (retain, nonatomic) NSString *endpointRapportEffectiveIdentifier; // ivar: _endpointRapportEffectiveIdentifier
@property (retain, nonatomic) NSString *endpointRapportMediaSystemIdentifier; // ivar: _endpointRapportMediaSystemIdentifier
@property (readonly) NSUInteger hash;
@property (nonatomic) CGSize localLandscapeAspectRatio; // ivar: _localLandscapeAspectRatio
@property (nonatomic) CGSize localPortraitAspectRatio; // ivar: _localPortraitAspectRatio
@property (nonatomic) BOOL pauseVideoToStart; // ivar: _pauseVideoToStart
@property (copy, nonatomic) NSString *sourceIdentifier; // ivar: _sourceIdentifier
@property (readonly) Class superclass;
@property (copy, nonatomic) NSString *uniqueProxyIdentifier; // ivar: _uniqueProxyIdentifier
@property (nonatomic) BOOL wantsHoldMusic; // ivar: _wantsHoldMusic


+(BOOL)supportsSecureCoding;
-(id)init;
-(id)initWithCall:(id)arg0 ;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithUniqueProxyIdentifier:(id)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
