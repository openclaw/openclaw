// Copyright 2020 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_CPPGC_COMMON_H_
#define INCLUDE_CPPGC_COMMON_H_

#include "v8config.h"  // NOLINT(build/include_directory)

namespace cppgc {

/**
 *  Indicator for the stack state of the embedder.
 */
enum class EmbedderStackState {
  /**
   * Stack may contain interesting heap pointers.
   */
  kMayContainHeapPointers,
  /**
   * Stack does not contain any interesting heap pointers.
   */
  kNoHeapPointers,
};

}  // namespace cppgc

#endif  // INCLUDE_CPPGC_COMMON_H_
