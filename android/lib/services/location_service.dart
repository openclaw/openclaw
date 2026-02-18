/// Optional GPS context for location-aware responses.

import 'dart:async';
import 'package:geolocator/geolocator.dart';
import 'gateway_service.dart';

class LocationService {
  final GatewayService _gateway;
  Timer? _timer;
  bool _enabled = false;

  LocationService(this._gateway);

  bool get enabled => _enabled;

  /// Start sending location context every 5 minutes.
  Future<bool> start() async {
    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      final requested = await Geolocator.requestPermission();
      if (requested == LocationPermission.denied ||
          requested == LocationPermission.deniedForever) {
        return false;
      }
    }
    _enabled = true;
    _sendOnce();
    _timer = Timer.periodic(const Duration(minutes: 5), (_) => _sendOnce());
    return true;
  }

  void stop() {
    _timer?.cancel();
    _enabled = false;
  }

  Future<void> _sendOnce() async {
    try {
      final pos = await Geolocator.getCurrentPosition(
        desiredAccuracy: LocationAccuracy.medium,
      );
      _gateway.sendContext({
        'location': {
          'lat': pos.latitude,
          'lng': pos.longitude,
          'accuracy': pos.accuracy,
          'timestamp': pos.timestamp.toIso8601String(),
        }
      });
    } catch (_) {}
  }

  void dispose() => stop();
}
