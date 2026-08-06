// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATIONMEMBER_H
#define TUCONVERSATIONMEMBER_H

@class NSDate, NSSet, NSString, NSArray;

#import <Foundation/Foundation.h>

#import "TUHandle.h"
#import "TUConversationMemberAssociation.h"

@interface TUConversationMember : NSObject



@property (copy, nonatomic) TUConversationMemberAssociation *association; // ivar: _association
@property (retain, nonatomic) NSObject *associationVoucher; // ivar: _associationVoucher
@property (nonatomic) NSDate *dateInitiatedLetMeIn; // ivar: _dateInitiatedLetMeIn
@property (nonatomic) NSDate *dateReceivedLetMeIn; // ivar: _dateReceivedLetMeIn
@property (readonly, nonatomic) TUHandle *handle; // ivar: _handle
@property (readonly, copy, nonatomic) NSSet *handles;
@property (readonly, copy, nonatomic) NSString *idsDestination;
@property (readonly, copy, nonatomic) NSArray *idsDestinations;
@property (readonly, copy, nonatomic) NSString *idsFromID;
@property (nonatomic) BOOL isLightweightMember; // ivar: _isLightweightMember
@property (nonatomic) BOOL isOtherInvitedHandle; // ivar: _isOtherInvitedHandle
@property (nonatomic) BOOL isSplitSessionMember;
@property (nonatomic) BOOL joinedFromLetMeIn; // ivar: _joinedFromLetMeIn
@property (copy, nonatomic) TUHandle *lightweightPrimary; // ivar: _lightweightPrimary
@property (nonatomic) NSUInteger lightweightPrimaryParticipantIdentifier; // ivar: _lightweightPrimaryParticipantIdentifier
@property (copy, nonatomic) NSString *nickname; // ivar: _nickname
@property (copy, nonatomic) TUHandle *splitSessionPrimary;
@property (readonly, nonatomic, getter=isValidated) BOOL validated;
@property (nonatomic) NSInteger validationSource; // ivar: _validationSource


+(BOOL)supportsSecureCoding;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToMember:(id)arg0 ;
-(BOOL)pseudonym;
-(BOOL)representsSameMemberAs:(id)arg0 ;
-(NSUInteger)hash;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)description;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithContact:(id)arg0 ;
-(id)initWithContact:(id)arg0 additionalHandles:(id)arg1 ;
-(id)initWithDestination:(id)arg0 ;
-(id)initWithDestinations:(id)arg0 ;
-(id)initWithHandle:(id)arg0 ;
-(id)initWithHandle:(id)arg0 nickname:(id)arg1 ;
-(id)initWithHandle:(id)arg0 nickname:(id)arg1 joinedFromLetMeIn:(BOOL)arg2 ;
-(id)initWithHandles:(id)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
