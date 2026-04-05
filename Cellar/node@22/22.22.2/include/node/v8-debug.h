// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_DEBUG_H_
#define INCLUDE_V8_DEBUG_H_

#include <stdint.h>

#include "v8-script.h"  // NOLINT(build/include_directory)
#include "v8config.h"   // NOLINT(build/include_directory)

namespace v8 {

class Isolate;
class String;

/**
 * A single JavaScript stack frame.
 */
class V8_EXPORT StackFrame {
 public:
  /**
   * Returns the source location, 0-based, for the associated function call.
   */
  Location GetLocation() const;

  /**
   * Returns the number, 1-based, of the line for the associate function call.
   * This method will return Message::kNoLineNumberInfo if it is unable to
   * retrieve the line number, or if kLineNumber was not passed as an option
   * when capturing the StackTrace.
   */
  int GetLineNumber() const { return GetLocation().GetLineNumber() + 1; }

  /**
   * Returns the 1-based column offset on the line for the associated function
   * call.
   * This method will return Message::kNoColumnInfo if it is unable to retrieve
   * the column number, or if kColumnOffset was not passed as an option when
   * capturing the StackTrace.
   */
  int GetColumn() const { return GetLocation().GetColumnNumber() + 1; }

  /**
   * Returns the id of the script for the function for this StackFrame.
   * This method will return Message::kNoScriptIdInfo if it is unable to
   * retrieve the script id, or if kScriptId was not passed as an option when
   * capturing the StackTrace.
   */
  int GetScriptId() const;

  /**
   * Returns the name of the resource that contains the script for the
   * function for this StackFrame.
   */
  Local<String> GetScriptName() const;

  /**
   * Returns the name of the resource that contains the script for the
   * function for this StackFrame or sourceURL value if the script name
   * is undefined and its source ends with //# sourceURL=... string or
   * deprecated //@ sourceURL=... string.
   */
  Local<String> GetScriptNameOrSourceURL() const;

  /**
   * Returns the source of the script for the function for this StackFrame.
   */
  Local<String> GetScriptSource() const;

  /**
   * Returns the source mapping URL (if one is present) of the script for
   * the function for this StackFrame.
   */
  Local<String> GetScriptSourceMappingURL() const;

  /**
   * Returns the name of the function associated with this stack frame.
   */
  Local<String> GetFunctionName() const;

  /**
   * Returns whether or not the associated function is compiled via a call to
   * eval().
   */
  bool IsEval() const;

  /**
   * Returns whether or not the associated function is called as a
   * constructor via "new".
   */
  bool IsConstructor() const;

  /**
   * Returns whether or not the associated functions is defined in wasm.
   */
  bool IsWasm() const;

  /**
   * Returns whether or not the associated function is defined by the user.
   */
  bool IsUserJavaScript() const;
};

/**
 * Representation of a JavaScript stack trace. The information collected is a
 * snapshot of the execution stack and the information remains valid after
 * execution continues.
 */
class V8_EXPORT StackTrace {
 public:
  /**
   * Flags that determine what information is placed captured for each
   * StackFrame when grabbing the current stack trace.
   * Note: these options are deprecated and we always collect all available
   * information (kDetailed).
   */
  enum StackTraceOptions {
    kLineNumber = 1,
    kColumnOffset = 1 << 1 | kLineNumber,
    kScriptName = 1 << 2,
    kFunctionName = 1 << 3,
    kIsEval = 1 << 4,
    kIsConstructor = 1 << 5,
    kScriptNameOrSourceURL = 1 << 6,
    kScriptId = 1 << 7,
    kExposeFramesAcrossSecurityOrigins = 1 << 8,
    kOverview = kLineNumber | kColumnOffset | kScriptName | kFunctionName,
    kDetailed = kOverview | kIsEval | kIsConstructor | kScriptNameOrSourceURL
  };

  /**
   * Returns a StackFrame at a particular index.
   */
  Local<StackFrame> GetFrame(Isolate* isolate, uint32_t index) const;

  /**
   * Returns the number of StackFrames.
   */
  int GetFrameCount() const;

  /**
   * Grab a snapshot of the current JavaScript execution stack.
   *
   * \param frame_limit The maximum number of stack frames we want to capture.
   * \param options Enumerates the set of things we will capture for each
   *   StackFrame.
   */
  static Local<StackTrace> CurrentStackTrace(
      Isolate* isolate, int frame_limit, StackTraceOptions options = kDetailed);

  /**
   * Returns the first valid script name or source URL starting at the top of
   * the JS stack. The returned string is either an empty handle if no script
   * name/url was found or a non-zero-length string.
   *
   * This method is equivalent to calling StackTrace::CurrentStackTrace and
   * walking the resulting frames from the beginning until a non-empty script
   * name/url is found. The difference is that this method won't allocate
   * a stack trace.
   */
  static Local<String> CurrentScriptNameOrSourceURL(Isolate* isolate);
};

}  // namespace v8

#endif  // INCLUDE_V8_DEBUG_H_
