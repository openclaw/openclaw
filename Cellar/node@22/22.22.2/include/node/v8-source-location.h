// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_SOURCE_LOCATION_H_
#define INCLUDE_SOURCE_LOCATION_H_

#include <cstddef>
#include <string>

#include "v8config.h"  // NOLINT(build/include_directory)

#if defined(__has_builtin)
#define V8_SUPPORTS_SOURCE_LOCATION                                      \
  (__has_builtin(__builtin_FUNCTION) && __has_builtin(__builtin_FILE) && \
   __has_builtin(__builtin_LINE))  // NOLINT
#elif defined(V8_CC_GNU) && __GNUC__ >= 7
#define V8_SUPPORTS_SOURCE_LOCATION 1
#elif defined(V8_CC_INTEL) && __ICC >= 1800
#define V8_SUPPORTS_SOURCE_LOCATION 1
#else
#define V8_SUPPORTS_SOURCE_LOCATION 0
#endif

namespace v8 {

/**
 * Encapsulates source location information. Mimics C++20's
 * `std::source_location`.
 */
class V8_EXPORT SourceLocation final {
 public:
  /**
   * Construct source location information corresponding to the location of the
   * call site.
   */
#if V8_SUPPORTS_SOURCE_LOCATION
  static constexpr SourceLocation Current(
      const char* function = __builtin_FUNCTION(),
      const char* file = __builtin_FILE(), size_t line = __builtin_LINE()) {
    return SourceLocation(function, file, line);
  }
#else
  static constexpr SourceLocation Current() { return SourceLocation(); }
#endif  // V8_SUPPORTS_SOURCE_LOCATION

  /**
   * Constructs unspecified source location information.
   */
  constexpr SourceLocation() = default;

  /**
   * Returns the name of the function associated with the position represented
   * by this object, if any.
   *
   * \returns the function name as cstring.
   */
  constexpr const char* Function() const { return function_; }

  /**
   * Returns the name of the current source file represented by this object.
   *
   * \returns the file name as cstring.
   */
  constexpr const char* FileName() const { return file_; }

  /**
   * Returns the line number represented by this object.
   *
   * \returns the line number.
   */
  constexpr size_t Line() const { return line_; }

  /**
   * Returns a human-readable string representing this object.
   *
   * \returns a human-readable string representing source location information.
   */
  std::string ToString() const;

 private:
  constexpr SourceLocation(const char* function, const char* file, size_t line)
      : function_(function), file_(file), line_(line) {}

  const char* function_ = nullptr;
  const char* file_ = nullptr;
  size_t line_ = 0u;
};

}  // namespace v8

#endif  // INCLUDE_SOURCE_LOCATION_H_
