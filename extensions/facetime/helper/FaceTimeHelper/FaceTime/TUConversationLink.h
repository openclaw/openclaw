// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATIONLINK_H
#define TUCONVERSATIONLINK_H

@class NSURL, NSString, NSDate, NSUUID, NSSet, NSData;

#import <Foundation/Foundation.h>
#import "TUHandle.h"

@interface TUConversationLink : NSObject <NSCopying, NSSecureCoding>



@property (readonly, nonatomic) NSURL *URL;
@property (retain, nonatomic) NSString *URLFragment; // ivar: _URLFragment
@property (retain, nonatomic) NSDate *creationDate; // ivar: _creationDate
@property (retain, nonatomic) NSDate *expirationDate; // ivar: _expirationDate
@property (retain, nonatomic) NSUUID *groupUUID; // ivar: _groupUUID
@property (copy, nonatomic) NSSet<TUHandle*> *invitedMemberHandles; // ivar: _invitedMemberHandles
@property (nonatomic) NSInteger linkLifetimeScope; // ivar: _linkLifetimeScope
@property (copy, nonatomic) NSString *linkName; // ivar: _linkName
@property (nonatomic, getter=isLocallyCreated) BOOL locallyCreated; // ivar: _locallyCreated
@property (retain, nonatomic) NSObject *originatorHandle; // ivar: _originatorHandle
@property (copy, nonatomic) NSString *pseudonym; // ivar: _pseudonym
@property (copy, nonatomic) NSData *publicKey; // ivar: _publicKey


+(BOOL)checkMatchingConversationLinkCriteriaForURL:(id)arg0 ;
+(BOOL)supportsSecureCoding;
+(NSUInteger)conversationLinkVersion;
+(id)baseURLComponentsForURL:(id)arg0 ;
+(id)conversationLinkComponentsFromURL:(id)arg0 ;
+(id)conversationLinkForURL:(id)arg0 ;
+(id)prefixedPseudonymFor:(id)arg0 ;
+(id)publicKeyForBase64EncodedString:(id)arg0 ;
+(id)userConfiguration;
-(BOOL)canCreateConversations;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToConversationLink:(id)arg0 ;
-(BOOL)isEquivalentToConversationLink:(id)arg0 ;
-(BOOL)isEquivalentToPseudonym:(id)arg0 andPublicKey:(id)arg1 ;
-(NSUInteger)hash;
-(id)base64PublicKey;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)description;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithDescriptor:(id)arg0 ;
-(id)initWithPseudonym:(id)arg0 publicKey:(id)arg1 groupUUID:(id)arg2 originatorHandle:(id)arg3 ;
-(id)initWithPseudonym:(id)arg0 publicKey:(id)arg1 groupUUID:(id)arg2 originatorHandle:(id)arg3 creationDate:(id)arg4 expirationDate:(id)arg5 invitedMemberHandles:(id)arg6 locallyCreated:(BOOL)arg7 linkName:(id)arg8 linkLifetimeScope:(NSInteger)arg9 ;
-(id)unprefixedPseudonym;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
