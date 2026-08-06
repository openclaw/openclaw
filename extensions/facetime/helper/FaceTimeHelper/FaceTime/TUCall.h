// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCALL_H
#define TUCALL_H

@class NSString, NSUUID, NSDictionary, NSArray, NSDate, NSNumber, NSURL, NSData, NSSet;
@protocol OS_dispatch_queue;

#import <Foundation/Foundation.h>

#import "TUCallCenter.h"
#import "TUProxyCall.h"
#import "TUHandle.h"

@interface TUCall : NSObject



@property (readonly, nonatomic) int abUID;
@property (readonly, copy, nonatomic) NSObject *activeRemoteParticipant; // ivar: _activeRemoteParticipant
@property (copy, nonatomic) NSString *announceProviderIdentifier; // ivar: _announceProviderIdentifier
@property (readonly, copy, nonatomic) NSString *audioCategory;
@property (readonly, copy, nonatomic) NSString *audioMode;
@property (readonly, nonatomic) NSObject *backingProvider;
@property (readonly, nonatomic, getter=isBlocked) BOOL blocked;
@property (nonatomic) NSInteger bluetoothAudioFormat; // ivar: _bluetoothAudioFormat
@property (readonly, weak, nonatomic) TUCallCenter *callCenter;
@property (readonly, nonatomic) CGFloat callDuration;
@property (readonly, copy, nonatomic) NSString *callDurationString;
@property (readonly, copy, nonatomic) NSUUID *callGroupUUID;
@property (readonly, copy, nonatomic) NSString *callHistoryIdentifier;
@property (readonly, nonatomic) NSObject *callNotificationManager; // ivar: _callNotificationManager
@property (readonly, nonatomic) int callRelaySupport;
@property (weak, nonatomic) NSObject *callServicesInterface; // ivar: _callServicesInterface
@property (readonly, nonatomic) NSDictionary *callStats;
@property (readonly, nonatomic) int callStatus;
@property (readonly, copy, nonatomic) NSString *callUUID;
@property (readonly, copy, nonatomic) NSString *callerNameFromNetwork;
@property (readonly, nonatomic) NSInteger cameraType;
@property (nonatomic) CGFloat clientMessageReceiveTime; // ivar: _clientMessageReceiveTime
@property (readonly, copy, nonatomic) NSString *companyName;
@property (retain, nonatomic) NSObject *comparativeCall; // ivar: _comparativeCall
@property (readonly, nonatomic, getter=isConferenced) BOOL conferenced;
@property (readonly, nonatomic, getter=isConnected) BOOL connected;
@property (readonly, nonatomic, getter=isConnecting) BOOL connecting;
@property (readonly, copy, nonatomic) NSString *contactIdentifier;
@property (readonly, copy, nonatomic) NSArray *contactIdentifiers;
@property (readonly, nonatomic, getter=isConversation) BOOL conversation;
@property (retain, nonatomic) NSDate *dateAnsweredOrDialed; // ivar: _dateAnsweredOrDialed
@property (retain, nonatomic) NSDate *dateConnected; // ivar: _dateConnected
@property (readonly, nonatomic) NSDate *dateCreated; // ivar: _dateCreated
@property (retain, nonatomic) NSDate *dateEnded; // ivar: _dateEnded
@property (retain, nonatomic) NSDate *dateSentInvitation; // ivar: _dateSentInvitation
@property (retain, nonatomic) NSDate *dateStartedConnecting; // ivar: _dateStartedConnecting
@property (readonly, copy, nonatomic) NSString *destinationID;
@property (readonly, copy, nonatomic) NSObject *dialRequestForRedial;
@property (nonatomic) int disconnectedReason; // ivar: _disconnectedReason
@property (readonly, copy, nonatomic) NSObject *displayContext;
@property (readonly, copy, nonatomic) NSString *displayFirstName;
@property (readonly, copy, nonatomic) NSString *displayName;
@property (readonly, nonatomic) NSObject *displayProvider;
@property (nonatomic, getter=isDownlinkMuted) BOOL downlinkMuted;
@property (readonly, nonatomic, getter=isEmergency) BOOL emergency;
@property (readonly, nonatomic, getter=isEmergencyCall) BOOL emergencyCall;
@property (readonly, nonatomic) NSString *endedErrorString;
@property (readonly, nonatomic) NSString *endedReasonString;
@property (readonly, copy, nonatomic) NSDictionary *endedReasonUserInfo;
@property (nonatomic, getter=isEndpointOnCurrentDevice) BOOL endpointOnCurrentDevice; // ivar: _endpointOnCurrentDevice
@property (nonatomic) int faceTimeIDStatus; // ivar: _faceTimeIDStatus
@property (readonly, nonatomic) NSInteger faceTimeTransportType;
@property (nonatomic, getter=isFailureExpected) BOOL failureExpected; // ivar: _failureExpected
@property (nonatomic) int filteredOutReason; // ivar: _filteredOutReason
@property (readonly, nonatomic, getter=isFromSiri) BOOL fromSiri;
@property (readonly, nonatomic) TUHandle *handle;
@property (readonly, nonatomic) NSNumber *handoffRecipientParticipant;
@property (copy, nonatomic) NSString *hardPauseDigits; // ivar: _hardPauseDigits
@property (readonly, nonatomic) NSString *hardPauseDigitsDisplayString;
@property (nonatomic) int hardPauseDigitsState; // ivar: _hardPauseDigitsState
@property (readonly, nonatomic) BOOL hasSentInvitation;
@property (nonatomic) BOOL hasUpdatedAudio; // ivar: _hasUpdatedAudio
@property (nonatomic) CGFloat hostCreationTime; // ivar: _hostCreationTime
@property (nonatomic) CGFloat hostMessageSendTime; // ivar: _hostMessageSendTime
@property (readonly, nonatomic, getter=isHostedOnCurrentDevice) BOOL hostedOnCurrentDevice;
@property (readonly, nonatomic) NSInteger identificationCategory; // ivar: _identificationCategory
@property (readonly, nonatomic) NSURL *imageURL; // ivar: _imageURL
@property (readonly, nonatomic, getter=isIncoming) BOOL incoming;
@property (readonly, nonatomic) NSInteger inputAudioPowerSpectrumToken;
@property (readonly, nonatomic, getter=isInternational) BOOL international; // ivar: _international
@property (readonly, nonatomic) BOOL isActive;
@property (readonly, nonatomic) BOOL isKnownCaller; // ivar: _isKnownCaller
@property (readonly, nonatomic) BOOL isOnHold;
@property (readonly, nonatomic) BOOL isSendingAudio;
@property (nonatomic) BOOL isSendingVideo;
@property (copy, nonatomic) NSString *isoCountryCode; // ivar: _isoCountryCode
@property (nonatomic) BOOL joinedFromLink; // ivar: _joinedFromLink
@property (readonly, nonatomic, getter=isJunk) BOOL junk;
@property (readonly, nonatomic) NSInteger junkConfidence; // ivar: _junkConfidence
@property (readonly, nonatomic) NSData *localFrequency;
@property (readonly, nonatomic) float localMeterLevel;
@property (readonly, copy, nonatomic) NSObject *localSenderIdentity;
@property (readonly, copy, nonatomic) NSUUID *localSenderIdentityAccountUUID;
@property (readonly, copy, nonatomic) NSUUID *localSenderIdentityUUID;
@property (readonly, nonatomic) NSString *localizedHandoffRecipientDeviceCategory;
@property (readonly, copy, nonatomic) NSString *localizedLabel;
@property (nonatomic) BOOL mediaPlaybackOnExternalDevice; // ivar: _mediaPlaybackOnExternalDevice
@property (readonly, nonatomic, getter=isMediaStalled) BOOL mediaStalled;
@property (nonatomic) BOOL mixesVoiceWithMedia; // ivar: _mixesVoiceWithMedia
@property (copy, nonatomic) NSObject *model; // ivar: _model
@property (readonly, nonatomic, getter=isMutuallyExclusiveCall) BOOL mutuallyExclusiveCall;
@property (readonly, nonatomic) BOOL needsManualInCallSounds;
@property (readonly, nonatomic) int originatingUIType; // ivar: _originatingUIType
@property (readonly, nonatomic, getter=isOutgoing) BOOL outgoing;
@property (readonly, nonatomic) NSInteger outputAudioPowerSpectrumToken;
@property (readonly, nonatomic) BOOL prefersExclusiveAccessToCellularNetwork;
@property (nonatomic) NSInteger priority; // ivar: _priority
@property (readonly, nonatomic) NSObject *provider;
@property (readonly, nonatomic) NSDictionary *providerContext; // ivar: _providerContext
@property (nonatomic) NSInteger provisionalHoldStatus; // ivar: _provisionalHoldStatus
@property (readonly, nonatomic, getter=isPTT) BOOL ptt; // ivar: _ptt
@property (retain, nonatomic) NSObject<OS_dispatch_queue> *queue; // ivar: _queue
@property (readonly, nonatomic, getter=isReceivingTransmission) BOOL receivingTransmission;
@property (readonly, nonatomic) NSString *reminderString;
@property (readonly, nonatomic) CGSize remoteAspectRatio;
@property (readonly, nonatomic) NSInteger remoteCameraOrientation;
@property (readonly, nonatomic) NSData *remoteFrequency;
@property (readonly, nonatomic) float remoteMeterLevel;
@property (readonly, copy, nonatomic) NSSet *remoteParticipantHandles;
@property (readonly, nonatomic) CGSize remoteScreenAspectRatio; // ivar: _remoteScreenAspectRatio
@property (readonly, nonatomic) NSInteger remoteScreenOrientation;
@property (readonly, nonatomic, getter=isRemoteUplinkMuted) BOOL remoteUplinkMuted;
@property (readonly, nonatomic) CGRect remoteVideoContentRect;
@property (nonatomic) BOOL requiresRemoteVideo;
@property (nonatomic) BOOL ringtoneSuppressedRemotely; // ivar: _ringtoneSuppressedRemotely
@property (readonly, nonatomic, getter=isRTT) BOOL rtt;
@property (readonly, nonatomic) NSObject *screenShareAttributes; // ivar: _screenShareAttributes
@property (readonly, nonatomic, getter=isSendingTransmission) BOOL sendingTransmission;
@property (readonly, nonatomic) int service;
@property (readonly, nonatomic) NSInteger serviceStatus; // ivar: _serviceStatus
@property (nonatomic, getter=isSharingScreen) BOOL sharingScreen; // ivar: _sharingScreen
@property (readonly, nonatomic) BOOL shouldDisplayLocationIfAvailable;
@property (readonly, nonatomic) BOOL shouldPlayDTMFTone;
@property (readonly, nonatomic) BOOL shouldSuppressInCallUI;
@property (nonatomic) BOOL shouldSuppressRingtone; // ivar: _shouldSuppressRingtone
@property (readonly, nonatomic, getter=isSOS) BOOL sos;
@property (nonatomic) NSInteger soundRegion; // ivar: _soundRegion
@property (copy, nonatomic) NSString *sourceIdentifier; // ivar: _sourceIdentifier
@property (readonly, nonatomic) CGFloat startTime;
@property (readonly, nonatomic) int status;
@property (readonly, nonatomic) BOOL statusIsProvisional;
@property (readonly, copy, nonatomic) NSString *suggestedDisplayName;
@property (readonly, nonatomic) BOOL supportsDTMFTones;
@property (nonatomic) BOOL supportsEmergencyFallback; // ivar: _supportsEmergencyFallback
@property (nonatomic) BOOL supportsRecents; // ivar: _supportsRecents
@property (readonly, nonatomic) BOOL supportsTTYWithVoice;
@property (readonly, nonatomic, getter=isThirdPartyVideo) BOOL thirdPartyVideo;
@property (nonatomic) int transitionStatus; // ivar: _transitionStatus
@property (readonly, nonatomic) NSInteger transmissionMode; // ivar: _transmissionMode
@property (readonly, nonatomic, getter=isTTY) BOOL tty;
@property (nonatomic) int ttyType; // ivar: _ttyType
@property (copy, nonatomic) NSString *uniqueProxyIdentifier; // ivar: _uniqueProxyIdentifier
@property (readonly, copy, nonatomic) NSUUID *uniqueProxyIdentifierUUID;
@property (nonatomic, getter=isUplinkMuted) BOOL uplinkMuted;
@property (readonly, nonatomic, getter=isUsingBaseband) BOOL usingBaseband;
@property (nonatomic) NSInteger verificationStatus; // ivar: _verificationStatus
@property (nonatomic, getter=isVideo) BOOL video; // ivar: _video
@property (retain, nonatomic) NSObject *videoCallAttributes; // ivar: _videoCallAttributes
@property (readonly, nonatomic, getter=isVideoDegraded) BOOL videoDegraded;
@property (readonly, nonatomic, getter=isVideoMirrored) BOOL videoMirrored;
@property (readonly, nonatomic, getter=isVideoPaused) BOOL videoPaused;
@property (readonly, nonatomic) NSInteger videoStreamToken;
@property (readonly, nonatomic, getter=isVoicemail) BOOL voicemail;
@property (readonly, nonatomic, getter=isVoIPCall) BOOL voipCall;
@property (nonatomic) BOOL wantsHoldMusic; // ivar: _wantsHoldMusic
@property (readonly, nonatomic) BOOL wantsStagingArea;
@property (readonly, nonatomic) BOOL wasDeclined;
@property (nonatomic) BOOL wasDialAssisted; // ivar: _wasDialAssisted
@property (nonatomic) BOOL wasPulledToCurrentDevice; // ivar: _wasPulledToCurrentDevice
@property (readonly, nonatomic, getter=isWiFiCall) BOOL wiFiCall;


+(BOOL)isJunkConfidenceLevelJunk:(NSInteger)arg0 ;
+(BOOL)supportsSecureCoding;
+(NSInteger)acceptableJunkConfidence;
+(NSInteger)maxJunkConfidence;
+(id)_supplementalDialTelephonyCallStringForLocString:(id)arg0 destination:(id)arg1 isPhoneNumber:(BOOL)arg2 includeFaceTimeAudio:(BOOL)arg3 ;
+(id)faceTimeSupplementalDialTelephonyCallStringIncludingFTA:(BOOL)arg0 ;
+(id)supplementalDialTelephonyCallString;
+(id)supplementalDialTelephonyCallStringForDestination:(id)arg0 isPhoneNumber:(BOOL)arg1 ;
-(BOOL)hasRelaySupport:(int)arg0 ;
-(BOOL)isDialRequestVideoUpgrade:(id)arg0 ;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToCall:(id)arg0 ;
-(BOOL)isMuted;
-(BOOL)isVideoUpgradeFromCall:(id)arg0 ;
-(BOOL)setMuted:(BOOL)arg0 ;
-(NSUInteger)hash;
-(id)description;
-(id)errorAlertMessage;
-(id)errorAlertTitle;
-(id)init;
-(id)initWithCall:(id)arg0 ;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithUniqueProxyIdentifier:(id)arg0 ;
-(id)initWithUniqueProxyIdentifier:(id)arg0 endpointOnCurrentDevice:(BOOL)arg1 ;
-(id)supplementalInCallString;
-(struct CGSize )localAspectRatioForOrientation:(NSInteger)arg0 ;
-(void)answerWithRequest:(id)arg0 ;
-(void)dealloc;
-(void)disconnectWithReason:(int)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;
-(void)groupWithOtherCall:(id)arg0 ;
-(void)hold;
-(void)playDTMFToneForKey:(unsigned char)arg0 ;
-(void)postNotificationsAfterUpdatesInBlock:(id)arg0 ;
-(void)resetProvisionalState;
-(void)sendHardPauseDigits;
-(void)setLocalVideoLayer:(id)arg0 forMode:(NSInteger)arg1 ;
-(void)setRemoteVideoLayer:(id)arg0 forMode:(NSInteger)arg1 ;
-(void)setRemoteVideoPresentationSize:(struct CGSize )arg0 ;
-(void)setRemoteVideoPresentationState:(int)arg0 ;
-(void)suppressRingtone;
-(void)suppressRingtoneDueToRemoteSuppression;
-(void)ungroup;
-(void)unhold;
-(void)updateComparativeCall;
-(void)updateWithCall:(id)arg0 ;


@end


#endif
