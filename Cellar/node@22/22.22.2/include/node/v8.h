// Copyright 2012 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** \mainpage V8 API Reference Guide
 *
 * V8 is Google's open source JavaScript engine.
 *
 * This set of documents provides reference material generated from the
 * V8 header files in the include/ subdirectory.
 *
 * For other documentation see https://v8.dev/.
 */

#ifndef INCLUDE_V8_H_
#define INCLUDE_V8_H_

#include <stddef.h>
#include <stdint.h>

#include <memory>

#include "cppgc/common.h"
#include "v8-array-buffer.h"       // NOLINT(build/include_directory)
#include "v8-container.h"          // NOLINT(build/include_directory)
#include "v8-context.h"            // NOLINT(build/include_directory)
#include "v8-data.h"               // NOLINT(build/include_directory)
#include "v8-date.h"               // NOLINT(build/include_directory)
#include "v8-debug.h"              // NOLINT(build/include_directory)
#include "v8-exception.h"          // NOLINT(build/include_directory)
#include "v8-extension.h"          // NOLINT(build/include_directory)
#include "v8-external.h"           // NOLINT(build/include_directory)
#include "v8-function.h"           // NOLINT(build/include_directory)
#include "v8-initialization.h"     // NOLINT(build/include_directory)
#include "v8-internal.h"           // NOLINT(build/include_directory)
#include "v8-isolate.h"            // NOLINT(build/include_directory)
#include "v8-json.h"               // NOLINT(build/include_directory)
#include "v8-local-handle.h"       // NOLINT(build/include_directory)
#include "v8-locker.h"             // NOLINT(build/include_directory)
#include "v8-maybe.h"              // NOLINT(build/include_directory)
#include "v8-memory-span.h"        // NOLINT(build/include_directory)
#include "v8-message.h"            // NOLINT(build/include_directory)
#include "v8-microtask-queue.h"    // NOLINT(build/include_directory)
#include "v8-microtask.h"          // NOLINT(build/include_directory)
#include "v8-object.h"             // NOLINT(build/include_directory)
#include "v8-persistent-handle.h"  // NOLINT(build/include_directory)
#include "v8-primitive-object.h"   // NOLINT(build/include_directory)
#include "v8-primitive.h"          // NOLINT(build/include_directory)
#include "v8-promise.h"            // NOLINT(build/include_directory)
#include "v8-proxy.h"              // NOLINT(build/include_directory)
#include "v8-regexp.h"             // NOLINT(build/include_directory)
#include "v8-script.h"             // NOLINT(build/include_directory)
#include "v8-snapshot.h"           // NOLINT(build/include_directory)
#include "v8-statistics.h"         // NOLINT(build/include_directory)
#include "v8-template.h"           // NOLINT(build/include_directory)
#include "v8-traced-handle.h"      // NOLINT(build/include_directory)
#include "v8-typed-array.h"        // NOLINT(build/include_directory)
#include "v8-unwinder.h"           // NOLINT(build/include_directory)
#include "v8-value-serializer.h"   // NOLINT(build/include_directory)
#include "v8-value.h"              // NOLINT(build/include_directory)
#include "v8-version.h"            // NOLINT(build/include_directory)
#include "v8-wasm.h"               // NOLINT(build/include_directory)
#include "v8config.h"              // NOLINT(build/include_directory)

// We reserve the V8_* prefix for macros defined in V8 public API and
// assume there are no name conflicts with the embedder's code.

/**
 * The v8 JavaScript engine.
 */
namespace v8 {

class Platform;

/**
 * \example shell.cc
 * A simple shell that takes a list of expressions on the
 * command-line and executes them.
 */

/**
 * \example process.cc
 */


}  // namespace v8

#endif  // INCLUDE_V8_H_
