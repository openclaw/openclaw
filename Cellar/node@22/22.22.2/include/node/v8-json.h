// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_JSON_H_
#define INCLUDE_V8_JSON_H_

#include "v8-local-handle.h"  // NOLINT(build/include_directory)
#include "v8config.h"         // NOLINT(build/include_directory)

namespace v8 {

class Context;
class Value;
class String;

/**
 * A JSON Parser and Stringifier.
 */
class V8_EXPORT JSON {
 public:
  /**
   * Tries to parse the string |json_string| and returns it as value if
   * successful.
   *
   * \param the context in which to parse and create the value.
   * \param json_string The string to parse.
   * \return The corresponding value if successfully parsed.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<Value> Parse(
      Local<Context> context, Local<String> json_string);

  /**
   * Tries to stringify the JSON-serializable object |json_object| and returns
   * it as string if successful.
   *
   * \param json_object The JSON-serializable object to stringify.
   * \return The corresponding string if successfully stringified.
   */
  static V8_WARN_UNUSED_RESULT MaybeLocal<String> Stringify(
      Local<Context> context, Local<Value> json_object,
      Local<String> gap = Local<String>());
};

}  // namespace v8

#endif  // INCLUDE_V8_JSON_H_
