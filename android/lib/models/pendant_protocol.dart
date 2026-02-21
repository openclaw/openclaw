/// Limitless pendant BLE protobuf protocol parser.
/// Reverse-engineered from Omi source: app/lib/services/devices/models.dart
///
/// Protocol:
///   BLE GATT → fragmented packets → reassemble → protobuf → Opus frames
///
/// Protobuf structure:
///   PendantMessage > StorageBuffer > FlashPage > AudioWrapper > AudioData > opus_frames

import 'dart:typed_data';
import '../config/zeke_config.dart';

/// Reassembles fragmented BLE packets into complete protobuf messages.
class PacketReassembler {
  final Map<int, List<Uint8List>> _fragments = {};

  /// Add a fragment. Returns the complete message when all fragments received, else null.
  Uint8List? addFragment(Uint8List data) {
    if (data.length < 3) return null;

    final index = data[0];
    final sequence = data[1];
    final numFragments = data[2];
    final payload = data.sublist(3);

    _fragments.putIfAbsent(index, () => List.filled(numFragments, Uint8List(0)));

    if (sequence < numFragments) {
      _fragments[index]![sequence] = payload;
    }

    // Check if all fragments received
    if (_fragments[index]!.every((f) => f.isNotEmpty)) {
      final complete = _fragments.remove(index)!;
      final totalLen = complete.fold<int>(0, (sum, f) => sum + f.length);
      final result = Uint8List(totalLen);
      var offset = 0;
      for (final frag in complete) {
        result.setRange(offset, offset + frag.length, frag);
        offset += frag.length;
      }
      return result;
    }
    return null;
  }

  void clear() => _fragments.clear();
}

/// Extracts Opus audio frames from protobuf-encoded pendant messages.
class OpusExtractor {
  /// Parse a complete protobuf message and extract Opus frames.
  static List<Uint8List> extractFrames(Uint8List data) {
    final frames = <Uint8List>[];
    _parseProtobuf(data, 0, data.length, frames, 0);
    return frames;
  }

  /// Recursively parse protobuf fields looking for Opus frames.
  static void _parseProtobuf(
      Uint8List data, int start, int end, List<Uint8List> frames, int depth) {
    if (depth > 10) return; // Prevent infinite recursion

    var pos = start;
    while (pos < end) {
      // Read varint tag
      final tagResult = _readVarint(data, pos, end);
      if (tagResult == null) break;
      pos = tagResult.nextPos;

      final wireType = tagResult.value & 0x07;

      switch (wireType) {
        case 0: // Varint
          final skip = _readVarint(data, pos, end);
          if (skip == null) return;
          pos = skip.nextPos;
          break;
        case 1: // 64-bit
          pos += 8;
          break;
        case 2: // Length-delimited (strings, bytes, nested messages)
          final lenResult = _readVarint(data, pos, end);
          if (lenResult == null) return;
          pos = lenResult.nextPos;
          final len = lenResult.value;
          if (pos + len > end) return;

          final payload = data.sublist(pos, pos + len);

          // Check if this is an Opus frame
          if (_isOpusFrame(payload)) {
            frames.add(payload);
          } else {
            // Try parsing as nested protobuf
            _parseProtobuf(data, pos, pos + len, frames, depth + 1);
          }
          pos += len;
          break;
        case 5: // 32-bit
          pos += 4;
          break;
        default:
          return; // Unknown wire type, stop parsing
      }
    }
  }

  /// Check if a byte array looks like a valid Opus frame.
  static bool _isOpusFrame(Uint8List data) {
    if (data.length < ZekeConfig.minOpusFrameBytes ||
        data.length > ZekeConfig.maxOpusFrameBytes) {
      return false;
    }
    // Validate Opus TOC byte
    final toc = data[0];
    final config = (toc >> 3) & 0x1F;
    return config <= 31;
  }

  static _VarintResult? _readVarint(Uint8List data, int pos, int end) {
    int value = 0;
    int shift = 0;
    while (pos < end) {
      final byte = data[pos++];
      value |= (byte & 0x7F) << shift;
      if ((byte & 0x80) == 0) return _VarintResult(value, pos);
      shift += 7;
      if (shift > 63) return null;
    }
    return null;
  }
}

class _VarintResult {
  final int value;
  final int nextPos;
  _VarintResult(this.value, this.nextPos);
}

/// Limitless pendant initialization commands.
class PendantCommands {
  /// Encode "set current time" command for pendant RTC sync.
  static Uint8List encodeSetCurrentTime(DateTime time) {
    final ms = time.millisecondsSinceEpoch;
    final data = Uint8List(9);
    data[0] = 0x01; // Command: set time
    // Little-endian 64-bit timestamp
    for (var i = 0; i < 8; i++) {
      data[i + 1] = (ms >> (i * 8)) & 0xFF;
    }
    return data;
  }

  /// Encode "enable data stream" command.
  static Uint8List encodeEnableDataStream() {
    return Uint8List.fromList([0x02]); // Command: start streaming
  }

  /// Encode "disable data stream" command.
  static Uint8List encodeDisableDataStream() {
    return Uint8List.fromList([0x03]); // Command: stop streaming
  }
}
