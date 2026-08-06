// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATION_H
#define TUCONVERSATION_H

@class NSUUID, NSSet, NSString, NSArray;

#import <Foundation/Foundation.h>

#import "TUHandle.h"
#import "TUConversationLink.h"

@interface TUConversation : NSObject <NSCopying, NSSecureCoding>



@property (retain, nonatomic) NSUUID *UUID; // ivar: _UUID
@property (copy, nonatomic) NSSet *activeLightweightParticipants; // ivar: _activeLightweightParticipants
@property (copy, nonatomic) NSSet *activeRemoteParticipants; // ivar: _activeRemoteParticipants
@property (copy, nonatomic) NSSet *activitySessions; // ivar: _activitySessions
@property (nonatomic, getter=isAudioEnabled) BOOL audioEnabled; // ivar: _audioEnabled
@property (nonatomic) NSUInteger avMode; // ivar: _avMode
@property (copy, nonatomic) NSString *avcSessionIdentifier; // ivar: _avcSessionIdentifier
@property (nonatomic) NSInteger avcSessionToken; // ivar: _avcSessionToken
@property (nonatomic, getter=isBackedByGroupSession) BOOL backedByGroupSession; // ivar: _backedByGroupSession
@property (retain, nonatomic) NSObject *featureFlags; // ivar: _featureFlags
@property (nonatomic, getter=isFromStorage) BOOL fromStorage; // ivar: _fromStorage
@property (retain, nonatomic) NSUUID *groupUUID; // ivar: _groupUUID
@property (retain, nonatomic) NSObject *handoffEligibility; // ivar: _handoffEligibility
@property (nonatomic, getter=hasJoined) BOOL hasJoined; // ivar: _hasJoined
@property (nonatomic) BOOL hasReceivedLetMeInRequest; // ivar: _hasReceivedLetMeInRequest
@property (copy, nonatomic) NSSet *highlightIdentifiers; // ivar: _highlightIdentifiers
@property (nonatomic) BOOL ignoreLMIRequests; // ivar: _ignoreLMIRequests
@property (retain, nonatomic) TUHandle *initiator; // ivar: _initiator
@property (copy, nonatomic) NSSet *invitationPreferences; // ivar: _invitationPreferences
@property (nonatomic) BOOL isAnyOtherAccountDeviceActive; // ivar: _isAnyOtherAccountDeviceActive
@property (copy, nonatomic) NSSet *kickedMembers; // ivar: _kickedMembers
@property (nonatomic) NSInteger letMeInRequestState; // ivar: _letMeInRequestState
@property (copy, nonatomic) NSSet *lightweightMembers; // ivar: _lightweightMembers
@property (retain, nonatomic) TUConversationLink *link; // ivar: _link
@property (retain, nonatomic) NSObject *localMember; // ivar: _localMember
@property (retain, nonatomic) NSObject *localParticipantAssociation; // ivar: _localParticipantAssociation
@property (nonatomic) NSUInteger localParticipantIdentifier; // ivar: _localParticipantIdentifier
@property (nonatomic, getter=isLocallyCreated) BOOL locallyCreated; // ivar: _locallyCreated
@property (nonatomic) NSInteger maxVideoDecodesAllowed; // ivar: _maxVideoDecodesAllowed
@property (copy, nonatomic) NSString *messagesGroupName; // ivar: _messagesGroupName
@property (retain, nonatomic) NSUUID *messagesGroupUUID; // ivar: _messagesGroupUUID
@property (nonatomic, getter=isMirageEnabled) BOOL mirageEnabled; // ivar: _mirageEnabled
@property (nonatomic, getter=isOneToOneHandoffOngoing) BOOL oneToOneHandoffOngoing; // ivar: _oneToOneHandoffOngoing
@property (nonatomic, getter=isOneToOneModeEnabled) BOOL oneToOneModeEnabled; // ivar: _oneToOneModeEnabled
@property (copy, nonatomic) NSSet *otherInvitedHandles; // ivar: _otherInvitedHandles
@property (copy, nonatomic) NSSet *participantHandles; // ivar: _participantHandles
@property (nonatomic, getter=isPendingConversation) BOOL pendingConversation; // ivar: _pendingConversation
@property (copy, nonatomic) NSSet *pendingMembers; // ivar: _pendingMembers
@property (retain, nonatomic) NSObject *provider; // ivar: _provider
@property (copy, nonatomic) NSSet *rejectedMembers; // ivar: _rejectedMembers
@property (copy, nonatomic) NSSet *remoteMembers; // ivar: _remoteMembers
@property (copy, nonatomic) NSObject *report; // ivar: _report
@property (retain, nonatomic) NSObject *reportingHierarchySubToken; // ivar: _reportingHierarchySubToken
@property (retain, nonatomic) NSObject *reportingHierarchyToken; // ivar: _reportingHierarchyToken
@property (readonly, nonatomic) NSUInteger resolvedAudioVideoMode;
@property (nonatomic, getter=isScreenEnabled) BOOL screenEnabled; // ivar: _screenEnabled
@property (retain, nonatomic) NSUUID *selectiveSharingSessionUUID; // ivar: _selectiveSharingSessionUUID
@property (copy, nonatomic) NSObject *stagedActivitySession; // ivar: _stagedActivitySession
@property (nonatomic) NSInteger state; // ivar: _state
@property (copy, nonatomic) NSArray *supportedMediaTypes; // ivar: _supportedMediaTypes
@property (copy, nonatomic) NSSet *systemActivitySessions; // ivar: _systemActivitySessions
@property (nonatomic, getter=isVideoEnabled) BOOL videoEnabled; // ivar: _videoEnabled
@property (nonatomic, getter=isVideoPaused) BOOL videoPaused; // ivar: _videoPaused
@property (copy, nonatomic) NSSet *virtualParticipants; // ivar: _virtualParticipants


+(BOOL)supportsSecureCoding;
+(id)emptyConversationWithGroupUUID:(id)arg0 ;
+(id)numberFormatter;
-(BOOL)eligibleForDowngradeToAVModeNoneFromUI;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToConversation:(id)arg0 ;
-(BOOL)isRepresentedByRemoteMembers:(id)arg0 andLink:(id)arg1 ;
-(BOOL)isVideo;
-(BOOL)shouldShowInvitationOfStyles:(NSInteger)arg0 forHandle:(id)arg1 defaultValue:(BOOL)arg2 ;
-(BOOL)shouldShowInvitationRingingUIForAnyHandleType;
-(BOOL)shouldShowInvitationRingingUIForHandle:(id)arg0 ;
-(BOOL)shouldShowInvitationUserNotificationForHandle:(id)arg0 ;
-(BOOL)supportsAVMode:(NSUInteger)arg0 ;
-(BOOL)supportsMediaType:(NSInteger)arg0 ;
-(NSUInteger)hash;
-(id)bundleIdentifier;
-(id)contactNamesByHandleWithContactsDataSource:(id)arg0 ;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)description;
-(id)displayName;
-(id)handles;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithConversation:(id)arg0 ;
-(id)initWithUUID:(id)arg0 groupUUID:(id)arg1 ;
-(id)initWithUUID:(id)arg0 groupUUID:(id)arg1 provider:(id)arg2 ;
-(id)joinedActivitySession;
-(id)messagesGroupPhotoData;
-(id)mutableCopyWithZone:(struct _NSZone *)arg0 ;
-(id)remoteParticipantForLightweightParticipantHandle:(id)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;
-(void)setVideo:(BOOL)arg0 ;


@end


#endif
