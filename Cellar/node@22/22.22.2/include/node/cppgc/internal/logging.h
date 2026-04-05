// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_INTERNAL_LOGGING_H_
#define INCLUDE_CPPGC_INTERNAL_LOGGING_H_

#include "cppgc/source-location.h"
#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {
namespace internal {

void V8_EXPORT DCheckImpl(const char*,
                          const SourceLocation& = SourceLocation::Current());
[[noreturn]] void V8_EXPORT
FatalImpl(const char*, const SourceLocation& = SourceLocation::Current());

// Used to ignore -Wunused-variable.
template <typename>
struct EatParams {};

#if defined(DEBUG)
#define CPPGC_DCHECK_MSG(condition, message)  \
  do {                                        \
    if (V8_UNLIKELY(!(condition))) {          \
      ::cppgc::internal::DCheckImpl(message); \
    }                                         \
  } while (false)
#else  // !defined(DEBUG)
#define CPPGC_DCHECK_MSG(condition, message)                \
  (static_cast<void>(::cppgc::internal::EatParams<decltype( \
                         static_cast<void>(condition), message)>{}))
#endif  // !defined(DEBUG)

#define CPPGC_DCHECK(condition) CPPGC_DCHECK_MSG(condition, #condition)

#define CPPGC_CHECK_MSG(condition, message)  \
  do {                                       \
    if (V8_UNLIKELY(!(condition))) {         \
      ::cppgc::internal::FatalImpl(message); \
    }                                        \
  } while (false)

#define CPPGC_CHECK(condition) CPPGC_CHECK_MSG(condition, #condition)

}  // namespace internal
}  // namespace cppgc

#endif  // INCLUDE_CPPGC_INTERNAL_LOGGING_H_
