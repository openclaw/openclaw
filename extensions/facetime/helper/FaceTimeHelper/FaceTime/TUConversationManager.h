// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATIONMANAGER_H
#define TUCONVERSATIONMANAGER_H

@class NSSet, NSDictionary, NSMutableSet, NSString, NSMapTable;
@protocol TUConversationMessagesGroupProviding, OS_dispatch_queue;

#import <Foundation/Foundation.h>
#import "TUConversation.h"
#import "TUConversationLink.h"

@interface TUConversationManager : NSObject



@property (readonly, copy, nonatomic) NSSet<TUConversationLink*> *activatedConversationLinks;
@property (readonly, copy, nonatomic) NSSet<TUConversation*> *activeConversations;
@property (readonly, copy, nonatomic) NSDictionary *activityAuthorizedBundleIdentifiers;
@property (nonatomic) BOOL autoSharePlayEnabled;
@property (readonly, copy, nonatomic) NSObject *avLessConversation;
@property (retain, nonatomic) NSMutableSet *callsNotBackedByGroupSessionsPendingUpgrade; // ivar: _callsNotBackedByGroupSessionsPendingUpgrade
@property (retain, nonatomic) NSObject *collaborationManager; // ivar: _collaborationManager
@property (retain, nonatomic) NSMutableSet *conversationsNotBackedByGroupSessions; // ivar: _conversationsNotBackedByGroupSessions
@property (readonly, nonatomic) NSObject *dataSource; // ivar: _dataSource
@property (readonly, copy) NSString *debugDescription;
@property (readonly, nonatomic) NSMapTable *delegateToQueue; // ivar: _delegateToQueue
@property (readonly, copy) NSString *description;
@property (readonly, copy, nonatomic) NSObject *handoffEligibleConversation;
@property (readonly) NSUInteger hash;
@property (readonly, copy, nonatomic) NSSet *incomingPendingConversations;
@property (readonly, nonatomic) NSObject *mediaController; // ivar: _mediaController
@property (weak, nonatomic) NSObject *messagesGroupProvider; // ivar: _messagesGroupProvider
@property (nonatomic) NSUInteger nonSessionBackedConversationCreationMode; // ivar: _nonSessionBackedConversationCreationMode
@property (readonly, nonatomic) NSObject<OS_dispatch_queue> *nonSessionBackedConversationCreationQueue; // ivar: _nonSessionBackedConversationCreationQueue
@property (readonly, nonatomic) NSObject<OS_dispatch_queue> *queue; // ivar: _queue
@property (readonly, nonatomic, getter=isScreenSharingAvailable) BOOL screenSharingAvailable;
@property (readonly, nonatomic, getter=isSharePlayAvailable) BOOL sharePlayAvailable;
@property (nonatomic) BOOL shouldCreateConversationsForCallsNotBackedByGroupSessions; // ivar: _shouldCreateConversationsForCallsNotBackedByGroupSessions
@property (readonly) Class superclass;


+(BOOL)allowsPortraitBlurWhenCaptionsEnabled;
+(BOOL)allowsScreenSharing;
+(BOOL)allowsScreenSharingWithVideo;
+(BOOL)allowsVideo;
+(BOOL)isAddPersonEnabled;
+(BOOL)supportsConversations;
+(BOOL)supportsEffects;
+(NSInteger)conversationStateForCall:(id)arg0 ;
+(NSInteger)memorySize;
+(NSUInteger)maximumNumberOfInvitedMembers;
+(id)activeRemoteParticipantsForCall:(id)arg0 remoteMembers:(id)arg1 ;
+(id)conversationWithPseudonym:(id)arg0 fromConversations:(id)arg1 ;
+(id)conversationWithRemoteMembers:(id)arg0 andLink:(id)arg1 fromConversations:(id)arg2 ;
+(id)conversationWithRemoteMembers:(id)arg0 andLink:(id)arg1 fromConversations:(id)arg2 matchingVideo:(BOOL)arg3 backedByGroupSession:(BOOL)arg4 ;
+(id)conversationWithUUID:(id)arg0 fromConversations:(id)arg1 ;
+(id)conversationsWithRemoteMembers:(id)arg0 andLink:(id)arg1 fromConversations:(id)arg2 ;
+(id)pendingConversationWithLink:(id)arg0 fromConversations:(id)arg1 ;
+(id)remoteMembersForCall:(id)arg0 ;
-(BOOL)currentProcessCanAccessCollaborations;
-(BOOL)openCollaborationWithIdentifier:(id)arg0 forConversation:(id)arg1 ;
-(NSInteger)collaborationStateForConversation:(id)arg0 ;
-(id)activeConversationWithGroupUUID:(id)arg0 ;
-(id)activeConversationWithLinkForCall:(id)arg0 ;
-(id)activeConversationWithRemoteMembers:(id)arg0 andLink:(id)arg1 ;
-(id)activeConversationWithRemoteMembers:(id)arg0 andLink:(id)arg1 matchingVideo:(BOOL)arg2 backedByGroupSession:(BOOL)arg3 ;
-(id)callPendingUpgradeInConversationsWithGroupUUID:(id)arg0 ;
-(id)ckBundleIDForCollaborationIdentifier:(id)arg0 ;
-(id)collaborationForConversation:(id)arg0 ;
-(id)createConversationForCallNotBackedByGroupSession:(id)arg0 ;
-(id)handoffEligibleConversationForEligibility:(id)arg0 ;
-(id)init;
-(id)initWithDataSource:(id)arg0 ;
-(id)joinRequestForApplicableConversationWithHandoffEligibility:(id)arg0 ;
-(id)pendingConversationWithLink:(id)arg0 ;
-(void)activateConversationNoticeWithActionURL:(id)arg0 bundleIdentifier:(id)arg1 ;
-(void)activateLink:(id)arg0 completionHandler:(id)arg1 ;
-(void)activeParticipant:(id)arg0 addedHighlightToConversation:(id)arg1 highlightIdentifier:(id)arg2 oldHighlightIdentifier:(id)arg3 isFirstAdd:(BOOL)arg4 ;
-(void)activeParticipant:(id)arg0 removedHighlightFromConversation:(id)arg1 highlightIdentifier:(id)arg2 ;
-(void)activityAuthorizationsChangedForDataSource:(id)arg0 oldActivityAuthorizedBundleIdentifiers:(id)arg1 ;
-(void)addCollaboration:(id)arg0 forConversation:(id)arg1 ;
-(void)addCollaborationDictionary:(id)arg0 forConversation:(id)arg1 fromMe:(BOOL)arg2 ;
-(void)addCollaborationIdentifier:(id)arg0 forConversation:(id)arg1 ;
-(void)addDelegate:(id)arg0 queue:(id)arg1 ;
-(void)addInvitedMemberHandles:(id)arg0 toConversationLink:(id)arg1 completionHandler:(id)arg2 ;
-(void)addRemoteMembers:(id)arg0 otherInvitedHandles:(id)arg1 toConversation:(id)arg2 ;
-(void)addRemoteMembers:(id)arg0 toConversation:(id)arg1 ;
-(void)addedCollaborationDictionary:(id)arg0 forConversation:(id)arg1 ;
-(void)approvePendingMember:(id)arg0 forConversation:(id)arg1 ;
-(void)buzzMember:(id)arg0 conversation:(id)arg1 ;
-(void)callPropertiesChanged:(id)arg0 ;
-(void)checkLinkValidity:(id)arg0 completionHandler:(id)arg1 ;
-(void)collaborationChanged:(id)arg0 forConversation:(id)arg1 collaborationState:(NSInteger)arg2 ;
-(void)conversation:(id)arg0 addedMembersLocally:(id)arg1 ;
-(void)conversation:(id)arg0 buzzedMember:(id)arg1 ;
-(void)conversation:(id)arg0 collaborationStateChanged:(NSInteger)arg1 highlightIdentifier:(id)arg2 ;
-(void)conversation:(id)arg0 didChangeSceneAssociationForActivitySession:(id)arg1 ;
-(void)conversation:(id)arg0 didChangeStateForActivitySession:(id)arg1 ;
-(void)conversation:(id)arg0 participant:(id)arg1 addedCollaborationNotice:(id)arg2 ;
-(void)conversation:(id)arg0 participant:(id)arg1 addedNotice:(id)arg2 ;
-(void)conversation:(id)arg0 receivedActivitySessionEvent:(id)arg1 ;
-(void)conversation:(id)arg0 remoteParticipantWithIdentifier:(NSUInteger)arg1 updatedAudioEnabled:(BOOL)arg2 ;
-(void)conversation:(id)arg0 remoteParticipantWithIdentifier:(NSUInteger)arg1 updatedVideoEnabled:(BOOL)arg2 ;
-(void)conversation:(id)arg0 screenSharingChangedForParticipant:(id)arg1 ;
-(void)conversationManagerDataSource:(id)arg0 conversation:(id)arg1 appLaunchState:(NSUInteger)arg2 forActivitySession:(id)arg3 ;
-(void)conversationManagerDataSource:(id)arg0 didChangeActivatedConversationLinks:(id)arg1 ;
-(void)conversationManagerDataSource:(id)arg0 messagesGroupDetailsForMessagesGroupId:(id)arg1 completionHandler:(id)arg2 ;
-(void)conversationUpdateMessagesGroupPhoto:(id)arg0 ;
-(void)conversationUpdatedMessagesGroupPhoto:(id)arg0 ;
-(void)conversationsChangedForDataSource:(id)arg0 oldConversationsByGroupUUID:(id)arg1 ;
-(void)conversationsChangedForDataSource:(id)arg0 oldConversationsByGroupUUID:(id)arg1 newConversationsByGroupUUID:(id)arg2 creationQueue:(id)arg3 ;
-(void)conversationsChangedForDataSource:(id)arg0 updatedIncomingPendingConversationsByGroupUUID:(id)arg1 ;
-(void)conversationsChangedFromOldConversationsByGroupUUID:(id)arg0 newConversationsByGroupUUID:(id)arg1 ;
-(void)createActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)dealloc;
-(void)endActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)fetchUpcomingNoticeWithCompletionHandler:(id)arg0 ;
-(void)generateLinkForConversation:(id)arg0 completionHandler:(id)arg1 ;
-(void)generateLinkWithInvitedMemberHandles:(id)arg0 completionHandler:(id)arg1 ;
-(void)generateLinkWithInvitedMemberHandles:(id)arg0 linkLifetimeScope:(NSInteger)arg1 completionHandler:(id)arg2 ;
-(void)getActiveLinksWithCreatedOnly:(BOOL)arg0 completionHandler:(id)arg1 ;
-(void)getInactiveLinkWithCompletionHandler:(id)arg0 ;
-(void)getLatestRemoteScreenShareAttributesWithCompletionHandler:(id)arg0 ;
-(void)getMessagesGroupDetailsForConversationUUID:(id)arg0 completionHandler:(id)arg1 ;
-(void)invalidateLink:(id)arg0 completionHandler:(id)arg1 ;
-(void)joinConversationWithRequest:(id)arg0 ;
-(void)kickMember:(id)arg0 conversation:(id)arg1 ;
-(void)launchApplicationForActivitySession:(id)arg0 completionHandler:(id)arg1 ;
-(void)launchApplicationForActivitySessionUUID:(id)arg0 completionHandler:(id)arg1 ;
-(void)launchApplicationForActivitySessionUUID:(id)arg0 forceBackground:(BOOL)arg1 completionHandler:(id)arg2 ;
-(void)leaveActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)leaveConversationWithUUID:(id)arg0 ;
-(void)linkSyncStateIncludeLinks:(BOOL)arg0 WithCompletion:(id)arg1 ;
-(void)presentDismissalAlertForActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)pruneConversationsPendingUpgradeInConversationsWithGroupUUID:(id)arg0 ;
-(void)receivedTrackedPendingMember:(id)arg0 forConversationLink:(id)arg1 ;
-(void)refreshActiveConversations;
-(void)registerMessagesGroupUUIDForConversationUUID:(id)arg0 ;
-(void)registerWithCompletionHandler:(id)arg0 ;
-(void)rejectPendingMember:(id)arg0 forConversation:(id)arg1 ;
-(void)remoteScreenShareAttributesChanged:(id)arg0 isLocallySharing:(BOOL)arg1 ;
-(void)remoteScreenShareEndedWithReason:(id)arg0 ;
-(void)removeCollaborationIdentifier:(id)arg0 forConversation:(id)arg1 ;
-(void)removeConversationNoticeWithUUID:(id)arg0 ;
-(void)removeDelegate:(id)arg0 ;
-(void)renewLink:(id)arg0 expirationDate:(id)arg1 reason:(NSUInteger)arg2 completionHandler:(id)arg3 ;
-(void)requestScreenShareFromMember:(id)arg0 conversation:(id)arg1 ;
-(void)scheduleConversationLinkCheckInInitial:(BOOL)arg0 ;
-(void)screenSharingAvailableChanged:(BOOL)arg0 ;
-(void)serverDisconnectedForDataSource:(id)arg0 oldConversationsByGroupUUID:(id)arg1 ;
-(void)setActivityAuthorization:(BOOL)arg0 forBundleIdentifier:(id)arg1 ;
-(void)setAudioEnabled:(BOOL)arg0 forRemoteParticipantWithIdentifier:(NSUInteger)arg1 conversation:(id)arg2 ;
-(void)setDownlinkMuted:(BOOL)arg0 forRemoteParticipantsInConversation:(id)arg1 ;
-(void)setGridDisplayMode:(NSUInteger)arg0 conversation:(id)arg1 ;
-(void)setIgnoreLMIRequests:(BOOL)arg0 forConversation:(id)arg1 ;
-(void)setLinkName:(id)arg0 forConversationLink:(id)arg1 completionHandler:(id)arg2 ;
-(void)setLocalParticipantAudioVideoMode:(NSUInteger)arg0 forConversationUUID:(id)arg1 ;
-(void)setScreenEnabled:(BOOL)arg0 withScreenShareAttributes:(id)arg1 forConversationWithUUID:(id)arg2 ;
-(void)setUsingAirplay:(BOOL)arg0 onActivitySession:(id)arg1 onConversation:(id)arg2 ;
-(void)setVideoEnabled:(BOOL)arg0 forRemoteParticipantWithIdentifier:(NSUInteger)arg1 conversation:(id)arg2 ;
-(void)sharePlayAvailableChanged:(BOOL)arg0 ;
-(void)startTrackingCollaboration:(id)arg0 forConversation:(id)arg1 completionHandler:(id)arg2 ;
-(void)updateConversationsNotBackedByGroupSessionWithCall:(id)arg0 ;
-(void)updateConversationsNotBackedByGroupSessionWithCall:(id)arg0 conversationsByGroupUUID:(id)arg1 creationQueue:(id)arg2 ;
-(void)updateMessagesGroupName:(id)arg0 onConversation:(id)arg1 ;
-(void)updateURLWithDugongTokenIfNeeded:(id)arg0 collaboration:(id)arg1 handle:(id)arg2 completion:(id)arg3 ;


@end


#endif
