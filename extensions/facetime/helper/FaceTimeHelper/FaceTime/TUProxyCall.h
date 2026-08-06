// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUPROXYCALL_H
#define TUPROXYCALL_H

@class NSURL, NSString, NSUUID, NSDictionary, NSData, NSMutableDictionary, NSSet;

#import "TUHandle.h"
#import "TUCall.h"

@interface TUProxyCall : TUCall

 {
    BOOL _ptt;
    BOOL _isSendingVideo;
    BOOL _uplinkMuted;
    BOOL _downlinkMuted;
    BOOL _requiresRemoteVideo;
    BOOL _mixesVoiceWithMedia;
    NSURL *_imageURL;
    NSObject *_screenShareAttributes;
}


@property (copy, nonatomic) NSObject *activeRemoteParticipant; // ivar: _activeRemoteParticipant
@property (copy, nonatomic) NSString *announceProviderIdentifier; // ivar: _announceProviderIdentifier
@property (copy, nonatomic) NSString *audioCategory; // ivar: _audioCategory
@property (copy, nonatomic) NSString *audioMode; // ivar: _audioMode
@property (retain, nonatomic) NSObject *backingProvider;
@property (nonatomic, getter=isBlocked) BOOL blocked; // ivar: _blocked
@property (nonatomic) NSInteger bluetoothAudioFormat; // ivar: _bluetoothAudioFormat
@property (copy, nonatomic) NSUUID *callGroupUUID; // ivar: _callGroupUUID
@property (nonatomic) int callRelaySupport; // ivar: _callRelaySupport
@property (nonatomic) int callStatus; // ivar: _callStatus
@property (copy, nonatomic) NSString *callUUID; // ivar: _callUUID
@property (copy, nonatomic) NSString *callerNameFromNetwork; // ivar: _callerNameFromNetwork
@property (nonatomic) NSInteger cameraType; // ivar: _cameraType
@property (nonatomic, getter=isConversation) BOOL conversation; // ivar: _conversation
@property (readonly, copy) NSString *debugDescription;
@property (readonly, copy) NSString *description;
@property (copy, nonatomic) NSObject *displayContext; // ivar: _displayContext
@property (retain, nonatomic) NSObject *displayProvider;
@property (nonatomic, getter=isEmergency) BOOL emergency; // ivar: _emergency
@property (copy, nonatomic) NSString *endedErrorString; // ivar: _endedErrorString
@property (copy, nonatomic) NSString *endedReasonString; // ivar: _endedReasonString
@property (copy, nonatomic) NSDictionary *endedReasonUserInfo; // ivar: _endedReasonUserInfo
@property (nonatomic, getter=isFailureExpected) BOOL failureExpected; // ivar: _failureExpected
@property (retain, nonatomic) TUHandle *handle; // ivar: _handle
@property (readonly) NSUInteger hash;
@property (nonatomic, getter=isHostedOnCurrentDevice) BOOL hostedOnCurrentDevice; // ivar: _hostedOnCurrentDevice
@property (nonatomic) NSInteger inputAudioPowerSpectrumToken; // ivar: _inputAudioPowerSpectrumToken
@property (nonatomic, getter=isInternational) BOOL international; // ivar: _international
@property (nonatomic) BOOL isSendingAudio; // ivar: _isSendingAudio
@property (nonatomic) BOOL isVideo; // ivar: _isVideo
@property (copy, nonatomic) NSString *isoCountryCode; // ivar: _isoCountryCode
@property (retain, nonatomic) NSData *localFrequency; // ivar: _localFrequency
@property (nonatomic) float localMeterLevel; // ivar: _localMeterLevel
@property (copy, nonatomic) NSUUID *localSenderIdentityAccountUUID; // ivar: _localSenderIdentityAccountUUID
@property (copy, nonatomic) NSUUID *localSenderIdentityUUID; // ivar: _localSenderIdentityUUID
@property (retain, nonatomic) NSObject *localVideo; // ivar: _localVideo
@property (retain, nonatomic) NSMutableDictionary *localVideoModeToLayer; // ivar: _localVideoModeToLayer
@property (nonatomic, getter=isMediaStalled) BOOL mediaStalled; // ivar: _mediaStalled
@property (nonatomic, getter=isMutuallyExclusiveCall) BOOL mutuallyExclusiveCall; // ivar: _mutuallyExclusiveCall
@property (nonatomic) BOOL needsManualInCallSounds; // ivar: _needsManualInCallSounds
@property (nonatomic) int originatingUIType; // ivar: _originatingUIType
@property (nonatomic, getter=isOutgoing) BOOL outgoing; // ivar: _outgoing
@property (nonatomic) NSInteger outputAudioPowerSpectrumToken; // ivar: _outputAudioPowerSpectrumToken
@property (nonatomic) BOOL prefersExclusiveAccessToCellularNetwork; // ivar: _prefersExclusiveAccessToCellularNetwork
@property (retain, nonatomic) NSObject *provider; // ivar: _provider
@property (retain, nonatomic) NSDictionary *providerContext; // ivar: _providerContext
@property (weak, nonatomic) NSObject *proxyCallActionsDelegate; // ivar: _proxyCallActionsDelegate
@property (nonatomic, getter=isReceivingTransmission) BOOL receivingTransmission; // ivar: _receivingTransmission
@property (nonatomic) CGSize remoteAspectRatio; // ivar: _remoteAspectRatio
@property (nonatomic) NSInteger remoteCameraOrientation; // ivar: _remoteCameraOrientation
@property (retain, nonatomic) NSData *remoteFrequency; // ivar: _remoteFrequency
@property (nonatomic) float remoteMeterLevel; // ivar: _remoteMeterLevel
@property (copy, nonatomic) NSSet *remoteParticipantHandles; // ivar: _remoteParticipantHandles
@property (nonatomic) CGSize remoteScreenLandscapeAspectRatio; // ivar: _remoteScreenLandscapeAspectRatio
@property (nonatomic) NSInteger remoteScreenOrientation; // ivar: _remoteScreenOrientation
@property (nonatomic) CGSize remoteScreenPortraitAspectRatio; // ivar: _remoteScreenPortraitAspectRatio
@property (nonatomic, getter=isRemoteUplinkMuted) BOOL remoteUplinkMuted; // ivar: _remoteUplinkMuted
@property (retain, nonatomic) NSObject *remoteVideo; // ivar: _remoteVideo
@property (nonatomic) CGRect remoteVideoContentRect; // ivar: _remoteVideoContentRect
@property (retain, nonatomic) NSMutableDictionary *remoteVideoModeToLayer; // ivar: _remoteVideoModeToLayer
@property (nonatomic, getter=isSendingTransmission) BOOL sendingTransmission; // ivar: _sendingTransmission
@property (nonatomic) NSInteger serviceStatus; // ivar: _serviceStatus
@property (nonatomic, getter=isSharingScreen) BOOL sharingScreen; // ivar: _sharingScreen
@property (nonatomic) BOOL shouldSuppressInCallUI; // ivar: _shouldSuppressInCallUI
@property (nonatomic, getter=isSOS, setter=setSOS:) BOOL sos; // ivar: _sos
@property (readonly) Class superclass;
@property (nonatomic) BOOL supportsEmergencyFallback; // ivar: _supportsEmergencyFallback
@property (nonatomic) BOOL supportsTTYWithVoice; // ivar: _supportsTTYWithVoice
@property (nonatomic, getter=isThirdPartyVideo) BOOL thirdPartyVideo; // ivar: _thirdPartyVideo
@property (nonatomic) NSInteger transmissionMode; // ivar: _transmissionMode
@property (nonatomic) int ttyType; // ivar: _ttyType
@property (nonatomic, getter=isUsingBaseband) BOOL usingBaseband; // ivar: _usingBaseband
@property (nonatomic, getter=isVideoDegraded) BOOL videoDegraded; // ivar: _videoDegraded
@property (nonatomic, getter=isVideoMirrored) BOOL videoMirrored; // ivar: _videoMirrored
@property (nonatomic, getter=isVideoPaused) BOOL videoPaused; // ivar: _videoPaused
@property (nonatomic) NSInteger videoStreamToken; // ivar: _videoStreamToken
@property (nonatomic, getter=isVoicemail) BOOL voicemail; // ivar: _voicemail
@property (nonatomic) BOOL wantsStagingArea; // ivar: _wantsStagingArea


+(BOOL)supportsSecureCoding;
+(id)proxyCallWithCall:(id)arg0 ;
-(BOOL)isDownlinkMuted;
-(BOOL)isPTT;
-(BOOL)isSendingVideo;
-(BOOL)isUplinkMuted;
-(BOOL)mixesVoiceWithMedia;
-(BOOL)requiresRemoteVideo;
-(NSInteger)_cameraTypeForVideoAttributeCamera:(int)arg0 ;
-(NSInteger)_orientationForVideoAttributesOrientation:(int)arg0 ;
-(id)imageURL;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithUniqueProxyIdentifier:(id)arg0 endpointOnCurrentDevice:(BOOL)arg1 ;
-(id)screenShareAttributes;
-(int)avcRemoteVideoModeForMode:(NSInteger)arg0 ;
-(struct CGSize )localAspectRatioForOrientation:(NSInteger)arg0 ;
-(struct CGSize )remoteScreenAspectRatio;
-(void)_createLocalVideoIfNecessary;
-(void)_createRemoteVideoIfNecessary;
-(void)_synchronizeLocalVideo;
-(void)_synchronizeRemoteVideo;
-(void)_updateVideoCallAttributes:(id)arg0 ;
-(void)_updateVideoStreamToken:(NSInteger)arg0 ;
-(void)answerWithRequest:(id)arg0 ;
-(void)disconnectWithReason:(int)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;
-(void)playDTMFToneForKey:(unsigned char)arg0 ;
-(void)remoteVideoClient:(id)arg0 remoteMediaDidStall:(BOOL)arg1 ;
-(void)remoteVideoClient:(id)arg0 remoteScreenAttributesDidChange:(id)arg1 ;
-(void)remoteVideoClient:(id)arg0 remoteVideoAttributesDidChange:(id)arg1 ;
-(void)remoteVideoClient:(id)arg0 remoteVideoDidPause:(BOOL)arg1 ;
-(void)remoteVideoClient:(id)arg0 videoDidDegrade:(BOOL)arg1 ;
-(void)sendHardPauseDigits;
-(void)setCallDisconnectedDueToComponentCrash;
-(void)setDisconnectedReason:(int)arg0 ;
-(void)setDownlinkMuted:(BOOL)arg0 ;
-(void)setEndpointOnCurrentDevice:(BOOL)arg0 ;
-(void)setIsSendingVideo:(BOOL)arg0 ;
-(void)setMixesVoiceWithMedia:(BOOL)arg0 ;
-(void)setRequiresRemoteVideo:(BOOL)arg0 ;
-(void)setScreenShareAttributes:(id)arg0 ;
-(void)setShouldSuppressRingtone:(BOOL)arg0 ;
-(void)setTransitionStatus:(int)arg0 ;
-(void)setUplinkMuted:(BOOL)arg0 ;
-(void)setWantsHoldMusic:(BOOL)arg0 ;
-(void)updateProxyCallWithDaemon;
-(void)updateWithCall:(id)arg0 ;


@end


#endif
