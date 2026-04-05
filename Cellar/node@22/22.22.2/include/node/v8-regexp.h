
// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_REGEXP_H_
#define INCLUDE_V8_REGEXP_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8-object.h"        // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;

/**
 * An instance of the built-in RegExp constructor (ECMA-262, 15.10).
 */
class V8_EXPORT RegExp : public Object {
 public:
  /**
   * Regular expression flag bits. They can be or'ed to enable a set
   * of flags.
   * The kLinear value ('l') is experimental and can only be used with
   * --enable-experimental-regexp-engine.  RegExps with kLinear flag are
   *  guaranteed to be executed in asymptotic linear time wrt. the length of
   *  the subject string.
   */
  enum Flags {
    kNone = 0,
    kGlobal = 1 << 0,
    kIgnoreCase = 1 << 1,
    kMultiline = 1 << 2,
    kSticky = 1 << 3,
    kUnicode = 1 << 4,
    kDotAll = 1 << 5,
    kLinear = 1 << 6,
    kHasIndices = 1 << 7,
    kUnicodeSets = 1 << 8,
  };

  static constexpr int kFlagCount = 9;

  /**
   * Creates a regular expression from the given pattern string and
   * the flags bit field. May throw a JavaScript exception as
   * described in ECMA-262, 15.10.4.1.
   *
   * For example,
   *   RegExp::New(v8::String::New("foo"),
   *               static_cast<RegExp::Flags>(kGlobal | kMultiline))
   * is equivalent to evaluating "/foo/gm".
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<RegExp> New(Local<Context> context,
                                                      Local<String> pattern,
                                                      Flags flags);

  /**
   * Like New, but additionally specifies a backtrack limit. If the number of
   * backtracks done in one Exec call hits the limit, a match failure is
   * immediately returned.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<RegExp> NewWithBacktrackLimit(
      Local<Context> context, Local<String> pattern, Flags flags,
      uint32_t backtrack_limit);

  /**
   * Executes the current RegExp instance on the given subject string.
   * Equivalent to RegExp.prototype.exec as described in
   *
   *   https://tc39.es/ecma262/#sec-regexp.prototype.exec
   *
   * On success, an Array containing the matched strings is returned. On
   * failure, returns Null.
   *
   * Note: modifies global context state, accessible e.g. through RegExp.input.
   */
  V8_WARN_UNUSED_RESULT MaybeLocal<Object> Exec(Local<Context> context,
                                                Local<String> subject);

  /**
   * Returns the value of the source property: a string representing
   * the regular expression.
   */
  Local<String> GetSource() const;

  /**
   * Returns the flags bit field.
   */
  Flags GetFlags() const;

  V8_INLINE static RegExp* Cast(Value* value) {
#ifdef V8_ENABLE_CHECKS
    CheckCast(value);
#endif
    return static_cast<RegExp*>(value);
  }

 private:
  static void CheckCast(Value* obj);
};

}  // namespace v8

#endif  // INCLUDE_V8_REGEXP_H_
