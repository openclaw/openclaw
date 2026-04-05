// Copyright 2021 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef INCLUDE_V8_INITIALIZATION_H_
#define INCLUDE_V8_INITIALIZATION_H_

#include <stddef.h>
#include <stdint.h>

#include "v8-callbacks.h"  // NOLINT(build/include_directory)
#include "v8-internal.h"   // NOLINT(build/include_directory)
#include "v8-isolate.h"    // NOLINT(build/include_directory)
#include "v8-platform.h"   // NOLINT(build/include_directory)
#include "v8config.h"      // NOLINT(build/include_directory)

// We reserve the V8_* prefix for macros defined in V8 public API and
// assume there are no name conflicts with the embedder's code.

/**
 * The v8 JavaScript engine.
 */
namespace v8 {

class PageAllocator;
class Platform;
template <class K, class V, class T>
class PersistentValueMapBase;

/**
 * EntropySource is used as a callback function when v8 needs a source
 * of entropy.
 */
using EntropySource = bool (*)(unsigned char* buffer, size_t length);

/**
 * ReturnAddressLocationResolver is used as a callback function when v8 is
 * resolving the location of a return address on the stack. Profilers that
 * change the return address on the stack can use this to resolve the stack
 * location to wherever the profiler stashed the original return address.
 *
 * \param return_addr_location A location on stack where a machine
 *    return address resides.
 * \returns Either return_addr_location, or else a pointer to the profiler's
 *    copy of the original return address.
 *
 * \note The resolver function must not cause garbage collection.
 */
using ReturnAddressLocationResolver =
    uintptr_t (*)(uintptr_t return_addr_location);

using DcheckErrorCallback = void (*)(const char* file, int line,
                                     const char* message);

/**
 * Container class for static utility functions.
 */
class V8_EXPORT V8 {
 public:
  /**
   * Hand startup data to V8, in case the embedder has chosen to build
   * V8 with external startup data.
   *
   * Note:
   * - By default the startup data is linked into the V8 library, in which
   *   case this function is not meaningful.
   * - If this needs to be called, it needs to be called before V8
   *   tries to make use of its built-ins.
   * - To avoid unnecessary copies of data, V8 will point directly into the
   *   given data blob, so pretty please keep it around until V8 exit.
   * - Compression of the startup blob might be useful, but needs to
   *   handled entirely on the embedders' side.
   * - The call will abort if the data is invalid.
   */
  static void SetSnapshotDataBlob(StartupData* startup_blob);

  /** Set the callback to invoke in case of Dcheck failures. */
  static void SetDcheckErrorHandler(DcheckErrorCallback that);

  /**
   * Sets V8 flags from a string.
   */
  static void SetFlagsFromString(const char* str);
  static void SetFlagsFromString(const char* str, size_t length);

  /**
   * Sets V8 flags from the command line.
   */
  static void SetFlagsFromCommandLine(int* argc, char** argv,
                                      bool remove_flags);

  /** Get the version string. */
  static const char* GetVersion();

  /**
   * Initializes V8. This function needs to be called before the first Isolate
   * is created. It always returns true.
   */
  V8_INLINE static bool Initialize() {
    const int kBuildConfiguration =
        (internal::PointerCompressionIsEnabled() ? kPointerCompression : 0) |
        (internal::SmiValuesAre31Bits() ? k31BitSmis : 0) |
        (internal::SandboxIsEnabled() ? kSandbox : 0);
    return Initialize(kBuildConfiguration);
  }

  /**
   * Allows the host application to provide a callback which can be used
   * as a source of entropy for random number generators.
   */
  static void SetEntropySource(EntropySource source);

  /**
   * Allows the host application to provide a callback that allows v8 to
   * cooperate with a profiler that rewrites return addresses on stack.
   */
  static void SetReturnAddressLocationResolver(
      ReturnAddressLocationResolver return_address_resolver);

  /**
   * Releases any resources used by v8 and stops any utility threads
   * that may be running.  Note that disposing v8 is permanent, it
   * cannot be reinitialized.
   *
   * It should generally not be necessary to dispose v8 before exiting
   * a process, this should happen automatically.  It is only necessary
   * to use if the process needs the resources taken up by v8.
   */
  static bool Dispose();

  /**
   * Initialize the ICU library bundled with V8. The embedder should only
   * invoke this method when using the bundled ICU. Returns true on success.
   *
   * If V8 was compiled with the ICU data in an external file, the location
   * of the data file has to be provided.
   */
  static bool InitializeICU(const char* icu_data_file = nullptr);

  /**
   * Initialize the ICU library bundled with V8. The embedder should only
   * invoke this method when using the bundled ICU. If V8 was compiled with
   * the ICU data in an external file and when the default location of that
   * file should be used, a path to the executable must be provided.
   * Returns true on success.
   *
   * The default is a file called icudtl.dat side-by-side with the executable.
   *
   * Optionally, the location of the data file can be provided to override the
   * default.
   */
  static bool InitializeICUDefaultLocation(const char* exec_path,
                                           const char* icu_data_file = nullptr);

  /**
   * Initialize the external startup data. The embedder only needs to
   * invoke this method when external startup data was enabled in a build.
   *
   * If V8 was compiled with the startup data in an external file, then
   * V8 needs to be given those external files during startup. There are
   * three ways to do this:
   * - InitializeExternalStartupData(const char*)
   *   This will look in the given directory for the file "snapshot_blob.bin".
   * - InitializeExternalStartupDataFromFile(const char*)
   *   As above, but will directly use the given file name.
   * - Call SetSnapshotDataBlob.
   *   This will read the blobs from the given data structure and will
   *   not perform any file IO.
   */
  static void InitializeExternalStartupData(const char* directory_path);
  static void InitializeExternalStartupDataFromFile(const char* snapshot_blob);

  /**
   * Sets the v8::Platform to use. This should be invoked before V8 is
   * initialized.
   */
  static void InitializePlatform(Platform* platform);

  /**
   * Clears all references to the v8::Platform. This should be invoked after
   * V8 was disposed.
   */
  static void DisposePlatform();

#if defined(V8_ENABLE_SANDBOX)
  /**
   * Returns true if the sandbox is configured securely.
   *
   * If V8 cannot create a regular sandbox during initialization, for example
   * because not enough virtual address space can be reserved, it will instead
   * create a fallback sandbox that still allows it to function normally but
   * does not have the same security properties as a regular sandbox. This API
   * can be used to determine if such a fallback sandbox is being used, in
   * which case it will return false.
   */
  static bool IsSandboxConfiguredSecurely();

  /**
   * Provides access to the virtual address subspace backing the sandbox.
   *
   * This can be used to allocate pages inside the sandbox, for example to
   * obtain virtual memory for ArrayBuffer backing stores, which must be
   * located inside the sandbox.
   *
   * It should be assumed that an attacker can corrupt data inside the sandbox,
   * and so in particular the contents of pages allocagted in this virtual
   * address space, arbitrarily and concurrently. Due to this, it is
   * recommended to to only place pure data buffers in them.
   */
  static VirtualAddressSpace* GetSandboxAddressSpace();

  /**
   * Returns the size of the sandbox in bytes.
   *
   * This represents the size of the address space that V8 can directly address
   * and in which it allocates its objects.
   */
  static size_t GetSandboxSizeInBytes();

  /**
   * Returns the size of the address space reservation backing the sandbox.
   *
   * This may be larger than the sandbox (i.e. |GetSandboxSizeInBytes()|) due
   * to surrounding guard regions, or may be smaller than the sandbox in case a
   * fallback sandbox is being used, which will use a smaller virtual address
   * space reservation. In the latter case this will also be different from
   * |GetSandboxAddressSpace()->size()| as that will cover a larger part of the
   * address space than what has actually been reserved.
   */
  static size_t GetSandboxReservationSizeInBytes();
#endif  // V8_ENABLE_SANDBOX

  /**
   * Activate trap-based bounds checking for WebAssembly.
   *
   * \param use_v8_signal_handler Whether V8 should install its own signal
   * handler or rely on the embedder's.
   */
  static bool EnableWebAssemblyTrapHandler(bool use_v8_signal_handler);

#if defined(V8_OS_WIN)
  /**
   * On Win64, by default V8 does not emit unwinding data for jitted code,
   * which means the OS cannot walk the stack frames and the system Structured
   * Exception Handling (SEH) cannot unwind through V8-generated code:
   * https://code.google.com/p/v8/issues/detail?id=3598.
   *
   * This function allows embedders to register a custom exception handler for
   * exceptions in V8-generated code.
   */
  static void SetUnhandledExceptionCallback(
      UnhandledExceptionCallback callback);
#endif

  /**
   * Allows the host application to provide a callback that will be called when
   * v8 has encountered a fatal failure to allocate memory and is about to
   * terminate.
   */
  static void SetFatalMemoryErrorCallback(OOMErrorCallback callback);

  /**
   * Get statistics about the shared memory usage.
   */
  static void GetSharedMemoryStatistics(SharedMemoryStatistics* statistics);

 private:
  V8();

  enum BuildConfigurationFeatures {
    kPointerCompression = 1 << 0,
    k31BitSmis = 1 << 1,
    kSandbox = 1 << 2,
  };

  /**
   * Checks that the embedder build configuration is compatible with
   * the V8 binary and if so initializes V8.
   */
  static bool Initialize(int build_config);

  friend class Context;
  template <class K, class V, class T>
  friend class PersistentValueMapBase;
};

}  // namespace v8

#endif  // INCLUDE_V8_INITIALIZATION_H_
