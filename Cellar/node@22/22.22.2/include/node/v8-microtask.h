// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_MICROTASK_H_
#define INCLUDE_V8_MICROTASK_H_

namespace v8 {

class Isolate;

// --- Microtasks Callbacks ---
using MicrotasksCompletedCallbackWithData = void (*)(Isolate*, void*);
using MicrotaskCallback = void (*)(void* data);

/**
 * Policy for running microtasks:
 *   - explicit: microtasks are invoked with the
 *               Isolate::PerformMicrotaskCheckpoint() method;
 *   - scoped: microtasks invocation is controlled by MicrotasksScope objects;
 *   - auto: microtasks are invoked when the script call depth decrements
 *           to zero.
 */
enum class MicrotasksPolicy { kExplicit, kScoped, kAuto };

}  // namespace v8

#endif  // INCLUDE_V8_MICROTASK_H_
