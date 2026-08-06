// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUJOINCONVERSATIONREQUEST_H
#define TUJOINCONVERSATIONREQUEST_H

@class NSURL, NSUUID, NSString, NSSet, NSDictionary;

#import <Foundation/Foundation.h>

#import "TUHandle.h"
#import "TUConversationLink.h"

@interface TUJoinConversationRequest : NSObject



@property (readonly, nonatomic) NSURL *URL;
@property (retain, nonatomic) NSUUID *UUID; // ivar: _UUID
@property (retain, nonatomic) NSObject *activity; // ivar: _activity
@property (copy, nonatomic) NSString *audioSourceIdentifier; // ivar: _audioSourceIdentifier
@property (nonatomic) NSUInteger avMode; // ivar: _avMode
@property (retain, nonatomic) TUHandle *callerID; // ivar: _callerID
@property (retain, nonatomic) NSString *collaborationIdentifier; // ivar: _collaborationIdentifier
@property (copy, nonatomic) TUConversationLink *conversationLink; // ivar: _conversationLink
@property (readonly, copy) NSString *debugDescription;
@property (readonly, copy) NSString *description;
@property (readonly) NSUInteger hash;
@property (copy, nonatomic) NSSet *invitationPreferences; // ivar: _invitationPreferences
@property (nonatomic, getter=isJoiningConversationWithLink) BOOL joiningConversationWithLink; // ivar: _joiningConversationWithLink
@property (copy, nonatomic) NSString *messagesGroupName; // ivar: _messagesGroupName
@property (copy, nonatomic) NSUUID *messagesGroupUUID; // ivar: _messagesGroupUUID
@property (readonly, copy, nonatomic) NSDictionary *notificationStylesByHandleType;
@property (nonatomic) int originatingUIType; // ivar: _originatingUIType
@property (readonly, copy, nonatomic) NSSet *otherInvitedHandles; // ivar: _otherInvitedHandles
@property (copy, nonatomic) NSObject *participantAssociation; // ivar: _participantAssociation
@property (retain, nonatomic) NSObject *provider; // ivar: _provider
@property (copy, nonatomic) NSSet *remoteMembers; // ivar: _remoteMembers
@property (nonatomic) BOOL sendLetMeInRequest; // ivar: _sendLetMeInRequest
@property (nonatomic) BOOL shouldLaunchBackgroundInCallUI; // ivar: _shouldLaunchBackgroundInCallUI
@property (nonatomic) BOOL shouldSuppressInCallUI; // ivar: _shouldSuppressInCallUI
@property (nonatomic) BOOL showUIPrompt; // ivar: _showUIPrompt
@property (readonly) Class superclass;
@property (nonatomic, getter=isUplinkMuted) BOOL uplinkMuted; // ivar: _uplinkMuted
@property (nonatomic, getter=isVideo) BOOL video;
@property (nonatomic, getter=isVideoEnabled) BOOL videoEnabled; // ivar: _videoEnabled
@property (nonatomic) BOOL wantsStagingArea; // ivar: _wantsStagingArea


+(BOOL)joiningConversationWithLinkFromURLComponents:(id)arg0 ;
+(BOOL)sendLetMeInRequestFromURLComponents:(id)arg0 ;
+(BOOL)shouldSuppressInCallUIFromURLComponents:(id)arg0 ;
+(BOOL)showUIPromptFromURLComponents:(id)arg0 ;
+(BOOL)supportsSecureCoding;
+(BOOL)uplinkMutedFromURLComponents:(id)arg0 ;
+(BOOL)videoEnabledFromURLComponents:(id)arg0 ;
+(BOOL)videoFromURLComponents:(id)arg0 ;
+(BOOL)wantsStagingAreaFromURLComponents:(id)arg0 ;
+(NSUInteger)avModeFromURLComponents:(id)arg0 ;
+(id)audioSourceIdentifierFromURLComponents:(id)arg0 ;
+(id)callerIDFromURLComponents:(id)arg0 ;
+(id)collaborationIdentifierFromURLComponents:(id)arg0 ;
+(id)conversationLinkFromURLComponents:(id)arg0 ;
+(id)invitationPreferencesFromURLComponents:(id)arg0 ;
+(id)messagesGroupNameFromURLComponents:(id)arg0 ;
+(id)messagesGroupUUIDFromURLComponents:(id)arg0 ;
+(id)otherInvitedHandlesFromURLComponents:(id)arg0 ;
+(id)providerFromURLComponents:(id)arg0 ;
+(id)remoteMembersFromURLComponents:(id)arg0 ;
+(id)sanitizedMembersFromMembers:(id)arg0 ;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToRequest:(id)arg0 ;
-(BOOL)supportsAVMode:(NSUInteger)arg0 ;
-(id)bundleIdentifier;
-(id)contactNamesByHandleWithContactsDataSource:(id)arg0 ;
-(id)conversationMembersForIntent:(id)arg0 ;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)handles;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithConversation:(id)arg0 ;
-(id)initWithConversationLink:(id)arg0 otherInvitedHandles:(id)arg1 remoteMembers:(id)arg2 sendLetMeInRequest:(BOOL)arg3 ;
-(id)initWithConversationLink:(id)arg0 otherInvitedHandles:(id)arg1 sendLetMeInRequest:(BOOL)arg2 ;
-(id)initWithGroupUUID:(id)arg0 localParticipantHandle:(id)arg1 remoteParticipantHandles:(id)arg2 ;
-(id)initWithProvider:(id)arg0 remoteMemberHandles:(id)arg1 ;
-(id)initWithProvider:(id)arg0 remoteMembers:(id)arg1 otherInvitedHandles:(id)arg2 ;
-(id)initWithRemoteMembers:(id)arg0 ;
-(id)initWithRemoteMembers:(id)arg0 otherInvitedHandles:(id)arg1 ;
-(id)initWithURL:(id)arg0 ;
-(id)initWithUserActivity:(id)arg0 ;
-(id)joiningConversationWithLinkQueryItem;
-(id)queryItems;
-(id)uplinkMutedQueryItem;
-(id)userActivityUsingStartCallIntents;
-(id)videoEnabledQueryItem;
-(id)videoQueryItem;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
