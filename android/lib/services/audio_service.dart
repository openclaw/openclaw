/// Audio pipeline — pendant Opus frames → gateway stream.
/// Phone mic fallback planned for v2 (pending record package fix).

import 'dart:async';
import 'dart:typed_data';
import 'gateway_service.dart';
import 'limitless_service.dart';

enum AudioSource { pendant, microphone, none }

class AudioService {
  final GatewayService _gateway;
  final LimitlessService _limitless;

  StreamSubscription? _pendantSub;
  AudioSource _activeSource = AudioSource.none;

  int _framesSent = 0;
  int get framesSent => _framesSent;
  AudioSource get activeSource => _activeSource;

  AudioService(this._gateway, this._limitless);

  /// Start streaming from pendant audio.
  void startPendantStream() {
    stopAll();
    _activeSource = AudioSource.pendant;
    _gateway.sendAudioControl('start');

    _pendantSub = _limitless.audioFrames.listen((frame) {
      _gateway.sendAudioFrame(frame);
      _framesSent++;
    });
  }

  /// Placeholder: phone mic streaming (v2)
  Future<void> startMicStream() async {
    // TODO: Add phone mic recording in v2
    // The `record` package has a broken `record_linux` dependency.
    // For now, pendant is the primary audio source.
    stopAll();
    _activeSource = AudioSource.microphone;
    _gateway.sendAudioControl('start');
  }

  void stopAll() {
    _pendantSub?.cancel();
    if (_activeSource != AudioSource.none) {
      _gateway.sendAudioControl('stop');
    }
    _activeSource = AudioSource.none;
    _framesSent = 0;
  }

  void dispose() {
    stopAll();
  }
}
