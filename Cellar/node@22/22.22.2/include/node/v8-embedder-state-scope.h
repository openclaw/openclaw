// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_EMBEDDER_STATE_SCOPE_H_
#define INCLUDE_V8_EMBEDDER_STATE_SCOPE_H_

#include <memory>

#include "v8-internal.h"      // NOLINT(build/include_directory)
#include "v8-local-handle.h"  // NOLINT(build/include_directory)

namespace v8 {

class Context;

namespace internal {
class EmbedderState;
}  // namespace internal

// A StateTag represents a possible state of the embedder.
enum class EmbedderStateTag : uint8_t {
  // reserved
  EMPTY = 0,
  OTHER = 1,
  // embedder can define any state after
};

// A stack-allocated class that manages an embedder state on the isolate.
// After an EmbedderState scope has been created, a new embedder state will be
// pushed on the isolate stack.
class V8_EXPORT EmbedderStateScope {
 public:
  EmbedderStateScope(Isolate* isolate, Local<v8::Context> context,
                     EmbedderStateTag tag);

  ~EmbedderStateScope();

 private:
  // Declaring operator new and delete as deleted is not spec compliant.
  // Therefore declare them private instead to disable dynamic alloc
  void* operator new(size_t size);
  void* operator new[](size_t size);
  void operator delete(void*, size_t);
  void operator delete[](void*, size_t);

  std::unique_ptr<internal::EmbedderState> embedder_state_;
};

}  // namespace v8

#endif  // INCLUDE_V8_EMBEDDER_STATE_SCOPE_H_
