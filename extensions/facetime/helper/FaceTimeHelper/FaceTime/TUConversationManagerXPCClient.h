// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATIONMANAGERXPCCLIENT_H
#define TUCONVERSATIONMANAGERXPCCLIENT_H

@class NSSet, NSDictionary, NSString, NSNumber, NSXPCConnection;
@protocol OS_dispatch_queue;

#import <Foundation/Foundation.h>

@interface TUConversationManagerXPCClient : NSObject



@property (readonly, copy, nonatomic) NSSet *activatedConversationLinks;
@property (copy, nonatomic) NSDictionary *activityAuthorizedBundleIdentifiers; // ivar: _activityAuthorizedBundleIdentifiers
@property (nonatomic) BOOL autoSharePlayEnabled; // ivar: _autoSharePlayEnabled
@property (copy, nonatomic) NSDictionary *conversationsByGroupUUID; // ivar: _conversationsByGroupUUID
@property (readonly, copy) NSString *debugDescription;
@property (weak, nonatomic) NSObject *delegate; // ivar: _delegate
@property (readonly, copy) NSString *description;
@property (nonatomic) BOOL hasInitialState; // ivar: _hasInitialState
@property (nonatomic) BOOL hasRequestedInitialState; // ivar: _hasRequestedInitialState
@property (readonly) NSUInteger hash;
@property (readonly, copy, nonatomic) NSDictionary *incomingPendingConversationsByGroupUUID;
@property (readonly, nonatomic) BOOL isScreenSharingAvailable;
@property (readonly, nonatomic) BOOL isSharePlayAvailable;
@property (weak, nonatomic) NSObject *mediaDelegate; // ivar: _mediaDelegate
@property (readonly, copy, nonatomic) NSDictionary *pseudonymsByCallUUID;
@property (readonly, nonatomic) NSObject<OS_dispatch_queue> *queue; // ivar: _queue
@property (copy, nonatomic) NSNumber *screenSharingAvailable; // ivar: _screenSharingAvailable
@property (copy, nonatomic) NSNumber *sharePlayAvailable; // ivar: _sharePlayAvailable
@property (nonatomic) BOOL shouldConnectToHost; // ivar: _shouldConnectToHost
@property (nonatomic) int shouldConnectToken; // ivar: _shouldConnectToken
@property (readonly) Class superclass;
@property (retain, nonatomic) NSXPCConnection *xpcConnection; // ivar: _xpcConnection


+(id)asynchronousServer;
+(id)conversationManagerAllowedClasses;
+(id)conversationManagerClientXPCInterface;
+(id)conversationManagerServerXPCInterface;
+(id)synchronousServer;
+(void)setAsynchronousServer:(id)arg0 ;
+(void)setSynchronousServer:(id)arg0 ;
-(id)asynchronousServerWithErrorHandler:(id)arg0 ;
-(id)init;
-(id)synchronousServerWithErrorHandler:(id)arg0 ;
-(void)_invokeCompletionHandler:(id)arg0 ;
-(void)_requestInitialStateIfNecessary;
-(void)_requestInitialStateWithCompletionHandler:(id)arg0 ;
-(void)activateConversationNoticeWithActionURL:(id)arg0 bundleIdentifier:(id)arg1 ;
-(void)activateLink:(id)arg0 completionHandler:(id)arg1 ;
-(void)activeParticipant:(id)arg0 addedHighlightToConversation:(id)arg1 highlightIdentifier:(id)arg2 oldHighlightIdentifier:(id)arg3 isFirstAdd:(BOOL)arg4 ;
-(void)activeParticipant:(id)arg0 removedHighlightFromConversation:(id)arg1 highlightIdentifier:(id)arg2 ;
-(void)addCollaborationDictionary:(id)arg0 forConversationWithUUID:(id)arg1 fromMe:(BOOL)arg2 ;
-(void)addCollaborationIdentifier:(id)arg0 collaborationURL:(id)arg1 cloudKitAppBundleIDs:(id)arg2 forConversationUUID:(id)arg3 ;
-(void)addInvitedMemberHandles:(id)arg0 toConversationLink:(id)arg1 completionHandler:(id)arg2 ;
-(void)addRemoteMembers:(id)arg0 otherInvitedHandles:(id)arg1 toConversation:(id)arg2 ;
-(void)addedCollaborationDictionary:(id)arg0 forConversation:(id)arg1 ;
-(void)approvePendingMember:(id)arg0 forConversation:(id)arg1 ;
-(void)buzzMember:(id)arg0 conversation:(id)arg1 ;
-(void)checkLinkValidity:(id)arg0 completionHandler:(id)arg1 ;
-(void)conversation:(id)arg0 addedMembersLocally:(id)arg1 ;
-(void)conversation:(id)arg0 appLaunchState:(NSUInteger)arg1 forActivitySession:(id)arg2 ;
-(void)conversation:(id)arg0 buzzedMember:(id)arg1 ;
-(void)conversation:(id)arg0 collaborationStateChanged:(NSInteger)arg1 highlightIdentifier:(id)arg2 ;
-(void)conversation:(id)arg0 didChangeSceneAssociationForActivitySession:(id)arg1 ;
-(void)conversation:(id)arg0 didChangeStateForActivitySession:(id)arg1 ;
-(void)conversation:(id)arg0 participant:(id)arg1 addedNotice:(id)arg2 ;
-(void)conversation:(id)arg0 receivedActivitySessionEvent:(id)arg1 ;
-(void)conversation:(id)arg0 remoteParticipantWithIdentifier:(NSUInteger)arg1 updatedAudioEnabled:(BOOL)arg2 ;
-(void)conversation:(id)arg0 remoteParticipantWithIdentifier:(NSUInteger)arg1 updatedVideoEnabled:(BOOL)arg2 ;
-(void)conversation:(id)arg0 screenSharingChangedForParticipant:(id)arg1 ;
-(void)conversationUpdateMessagesGroupPhoto:(id)arg0 ;
-(void)conversationUpdatedMessagesGroupPhoto:(id)arg0 ;
-(void)createActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)dealloc;
-(void)endActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)fetchUpcomingNoticeWithCompletionHandler:(id)arg0 ;
-(void)generateLinkForConversation:(id)arg0 completionHandler:(id)arg1 ;
-(void)generateLinkWithInvitedMemberHandles:(id)arg0 linkLifetimeScope:(NSInteger)arg1 completionHandler:(id)arg2 ;
-(void)getActiveLinksWithCreatedOnly:(BOOL)arg0 completionHandler:(id)arg1 ;
-(void)getInactiveLinkWithCompletionHandler:(id)arg0 ;
-(void)getLatestRemoteScreenShareAttributesWithCompletionHandler:(id)arg0 ;
-(void)getMessagesGroupDetailsForConversationUUID:(id)arg0 completionHandler:(id)arg1 ;
-(void)getMessagesGroupDetailsForMessagesGroupUUID:(id)arg0 completionHandler:(id)arg1 ;
-(void)handleServerDisconnect;
-(void)invalidate;
-(void)invalidateLink:(id)arg0 completionHandler:(id)arg1 ;
-(void)joinConversationWithRequest:(id)arg0 ;
-(void)kickMember:(id)arg0 conversation:(id)arg1 ;
-(void)launchApplicationForActivitySessionUUID:(id)arg0 completionHandler:(id)arg1 ;
-(void)launchApplicationForActivitySessionUUID:(id)arg0 forceBackground:(BOOL)arg1 completionHandler:(id)arg2 ;
-(void)leaveActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)leaveConversationWithUUID:(id)arg0 ;
-(void)linkSyncStateIncludeLinks:(BOOL)arg0 WithCompletion:(id)arg1 ;
-(void)markCollaborationWithIdentifierOpened:(id)arg0 forConversationUUID:(id)arg1 ;
-(void)mediaPrioritiesChangedForConversation:(id)arg0 ;
-(void)presentDismissalAlertForActivitySession:(id)arg0 onConversation:(id)arg1 ;
-(void)receivedTrackedPendingMember:(id)arg0 forConversationLink:(id)arg1 ;
-(void)refreshActiveConversations;
-(void)registerMessagesGroupUUIDForConversationUUID:(id)arg0 ;
-(void)registerWithCompletionHandler:(id)arg0 ;
-(void)rejectPendingMember:(id)arg0 forConversation:(id)arg1 ;
-(void)remoteScreenShareAttributesChanged:(id)arg0 isLocallySharing:(BOOL)arg1 ;
-(void)remoteScreenShareEndedWithReason:(id)arg0 ;
-(void)removeCollaborationIdentifier:(id)arg0 forConversationUUID:(id)arg1 ;
-(void)removeConversationNoticeWithUUID:(id)arg0 ;
-(void)renewLink:(id)arg0 expirationDate:(id)arg1 reason:(NSUInteger)arg2 completionHandler:(id)arg3 ;
-(void)scheduleConversationLinkCheckInInitial:(BOOL)arg0 ;
-(void)screenSharingAvailableChanged:(BOOL)arg0 ;
-(void)setActivityAuthorization:(BOOL)arg0 forBundleIdentifier:(id)arg1 ;
-(void)setAudioEnabled:(BOOL)arg0 forRemoteParticipantWithIdentifier:(NSUInteger)arg1 conversation:(id)arg2 ;
-(void)setDownlinkMuted:(BOOL)arg0 forRemoteParticipantsInConversation:(id)arg1 ;
-(void)setGridDisplayMode:(NSUInteger)arg0 conversation:(id)arg1 ;
-(void)setIgnoreLetMeInRequests:(BOOL)arg0 forConversation:(id)arg1 ;
-(void)setLinkName:(id)arg0 forConversationLink:(id)arg1 completionHandler:(id)arg2 ;
-(void)setLocalParticipantAudioVideoMode:(NSUInteger)arg0 forConversationUUID:(id)arg1 ;
-(void)setScreenEnabled:(BOOL)arg0 withScreenShareAttributes:(id)arg1 forConversationWithUUID:(id)arg2 ;
-(void)setSupportsMessagesGroupProviding:(BOOL)arg0 ;
-(void)setUsingAirplay:(BOOL)arg0 onActivitySession:(id)arg1 onConversationWithUUID:(id)arg2 ;
-(void)setVideoEnabled:(BOOL)arg0 forRemoteParticipantWithIdentifier:(NSUInteger)arg1 conversation:(id)arg2 ;
-(void)sharePlayAvailableChanged:(BOOL)arg0 ;
-(void)startTrackingCollaborationWithIdentifier:(id)arg0 collaborationURL:(id)arg1 cloudKitAppBundleIDs:(id)arg2 forConversationUUID:(id)arg3 completionHandler:(id)arg4 ;
-(void)updateActivatedConversationLinks:(id)arg0 ;
-(void)updateActivityAuthorizedBundleIdentifierState:(id)arg0 ;
-(void)updateConversationWithUUID:(id)arg0 participantPresentationContexts:(id)arg1 ;
-(void)updateConversationsByGroupUUID:(id)arg0 ;
-(void)updateIncomingPendingConversationsByGroupUUID:(id)arg0 ;
-(void)updateMessagesGroupName:(id)arg0 onConversation:(id)arg1 ;


@end


#endif
