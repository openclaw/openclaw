// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_MESSAGE_H_
#define INCLUDE_V8_MESSAGE_H_

#include <stdio.h>

#include <iosfwd>

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-maybe.h"         // NOLINT(build/include_directory)
#include "v8-primitive.h"     // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Integer;
class PrimitiveArray;
class StackTrace;
class String;
class Value;

/**
 * The optional attributes of ScriptOrigin.
 */
class ScriptOriginOptions {
 public:
  V8_INLINE ScriptOriginOptions(bool is_shared_cross_origin = false,
                                bool is_opaque = false, bool is_wasm = false,
                                bool is_module = false)
      : flags_((is_shared_cross_origin ? kIsSharedCrossOrigin : 0) |
               (is_wasm ? kIsWasm : 0) | (is_opaque ? kIsOpaque : 0) |
               (is_module ? kIsModule : 0)) {}
  V8_INLINE ScriptOriginOptions(int flags)
      : flags_(flags &
               (kIsSharedCrossOrigin | kIsOpaque | kIsWasm | kIsModule)) {}

  bool IsSharedCrossOrigin() const {
    return (flags_ & kIsSharedCrossOrigin) != 0;
  }
  bool IsOpaque() const { return (flags_ & kIsOpaque) != 0; }
  bool IsWasm() const { return (flags_ & kIsWasm) != 0; }
  bool IsModule() const { return (flags_ & kIsModule) != 0; }

  int Flags() const { return flags_; }

 private:
  enum {
    kIsSharedCrossOrigin = 1,
    kIsOpaque = 1 << 1,
    kIsWasm = 1 << 2,
    kIsModule = 1 << 3
  };
  const int flags_;
};

/**
 * The origin, within a file, of a script.
 */
class V8_EXPORT ScriptOrigin {
 public:
  V8_DEPRECATE_SOON("Use constructor without the isolate.")
  V8_INLINE ScriptOrigin(Isolate* isolate, Local<Value> resource_name,
                         int resource_line_offset = 0,
                         int resource_column_offset = 0,
                         bool resource_is_shared_cross_origin = false,
                         int script_id = -1,
                         Local<Value> source_map_url = Local<Value>(),
                         bool resource_is_opaque = false, bool is_wasm = false,
                         bool is_module = false,
                         Local<Data> host_defined_options = Local<Data>())
      : resource_name_(resource_name),
        resource_line_offset_(resource_line_offset),
        resource_column_offset_(resource_column_offset),
        options_(resource_is_shared_cross_origin, resource_is_opaque, is_wasm,
                 is_module),
        script_id_(script_id),
        source_map_url_(source_map_url),
        host_defined_options_(host_defined_options) {
    VerifyHostDefinedOptions();
  }

  V8_INLINE ScriptOrigin(Local<Value> resource_name,
                         int resource_line_offset = 0,
                         int resource_column_offset = 0,
                         bool resource_is_shared_cross_origin = false,
                         int script_id = -1,
                         Local<Value> source_map_url = Local<Value>(),
                         bool resource_is_opaque = false, bool is_wasm = false,
                         bool is_module = false,
                         Local<Data> host_defined_options = Local<Data>())
      : resource_name_(resource_name),
        resource_line_offset_(resource_line_offset),
        resource_column_offset_(resource_column_offset),
        options_(resource_is_shared_cross_origin, resource_is_opaque, is_wasm,
                 is_module),
        script_id_(script_id),
        source_map_url_(source_map_url),
        host_defined_options_(host_defined_options) {
    VerifyHostDefinedOptions();
  }

  V8_INLINE Local<Value> ResourceName() const;
  V8_INLINE int LineOffset() const;
  V8_INLINE int ColumnOffset() const;
  V8_INLINE int ScriptId() const;
  V8_INLINE Local<Value> SourceMapUrl() const;
  V8_INLINE Local<Data> GetHostDefinedOptions() const;
  V8_INLINE ScriptOriginOptions Options() const { return options_; }

 private:
  void VerifyHostDefinedOptions() const;
  Local<Value> resource_name_;
  int resource_line_offset_;
  int resource_column_offset_;
  ScriptOriginOptions options_;
  int script_id_;
  Local<Value> source_map_url_;
  Local<Data> host_defined_options_;
};

/**
 * An error message.
 */
class V8_EXPORT Message {
 public:
  Local<String> Get() const;

  /**
   * Return the isolate to which the Message belongs.
   */
  Isolate* GetIsolate() const;

  V8_WARN_UNUSED_RESULT MaybeLocal<String> GetSource(
      Local<Context> context) const;
  V8_WARN_UNUSED_RESULT MaybeLocal<String> GetSourceLine(
      Local<Context> context) const;

  /**
   * Returns the origin for the script from where the function causing the
   * error originates.
   */
  ScriptOrigin GetScriptOrigin() const;

  /**
   * Returns the resource name for the script from where the function causing
   * the error originates.
   */
  Local<Value> GetScriptResourceName() const;

  /**
   * Exception stack trace. By default stack traces are not captured for
   * uncaught exceptions. SetCaptureStackTraceForUncaughtExceptions allows
   * to change this option.
   */
  Local<StackTrace> GetStackTrace() const;

  /**
   * Returns the number, 1-based, of the line where the error occurred.
   */
  V8_WARN_UNUSED_RESULT Maybe<int> GetLineNumber(Local<Context> context) const;

  /**
   * Returns the index within the script of the first character where
   * the error occurred.
   */
  int GetStartPosition() const;

  /**
   * Returns the index within the script of the last character where
   * the error occurred.
   */
  int GetEndPosition() const;

  /**
   * Returns the Wasm function index where the error occurred. Returns -1 if
   * message is not from a Wasm script.
   */
  int GetWasmFunctionIndex() const;

  /**
   * Returns the error level of the message.
   */
  int ErrorLevel() const;

  /**
   * Returns the index within the line of the first character where
   * the error occurred.
   */
  int GetStartColumn() const;
  V8_WARN_UNUSED_RESULT Maybe<int> GetStartColumn(Local<Context> context) const;

  /**
   * Returns the index within the line of the last character where
   * the error occurred.
   */
  int GetEndColumn() const;
  V8_WARN_UNUSED_RESULT Maybe<int> GetEndColumn(Local<Context> context) const;

  /**
   * Passes on the value set by the embedder when it fed the script from which
   * this Message was generated to V8.
   */
  bool IsSharedCrossOrigin() const;
  bool IsOpaque() const;

  static void PrintCurrentStackTrace(Isolate* isolate, std::ostream& out);

  static const int kNoLineNumberInfo = 0;
  static const int kNoColumnInfo = 0;
  static const int kNoScriptIdInfo = 0;
  static const int kNoWasmFunctionIndexInfo = -1;
};

Local<Value> ScriptOrigin::ResourceName() const { return resource_name_; }

Local<Data> ScriptOrigin::GetHostDefinedOptions() const {
  return host_defined_options_;
}

int ScriptOrigin::LineOffset() const { return resource_line_offset_; }

int ScriptOrigin::ColumnOffset() const { return resource_column_offset_; }

int ScriptOrigin::ScriptId() const { return script_id_; }

Local<Value> ScriptOrigin::SourceMapUrl() const { return source_map_url_; }

}  // namespace v8

#endif  // INCLUDE_V8_MESSAGE_H_
