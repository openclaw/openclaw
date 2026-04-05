// Copyright 2013 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

#ifndef V8CONFIG_H_
#define V8CONFIG_H_

#ifdef V8_GN_HEADER
#if __cplusplus >= 201703L && !__has_include("v8-gn.h")
#error Missing v8-gn.h. The configuration for v8 is missing from the include \
path. Add it with -I<path> to the command line
#endif
#include "v8-gn.h"  // NOLINT(build/include_directory)
#endif

#include <memory>
// clang-format off

// Platform headers for feature detection below.
#if defined(__ANDROID__)
# include <sys/cdefs.h>
#elif defined(__APPLE__)
# include <TargetConditionals.h>
#elif defined(__linux__)
# include <features.h>
#endif


// This macro allows to test for the version of the GNU C library (or
// a compatible C library that masquerades as glibc). It evaluates to
// 0 if libc is not GNU libc or compatible.
// Use like:
//  #if V8_GLIBC_PREREQ(2, 3)
//   ...
//  #endif
#if defined(__GLIBC__) && defined(__GLIBC_MINOR__)
# define V8_GLIBC_PREREQ(major, minor)                                    \
    ((__GLIBC__ * 100 + __GLIBC_MINOR__) >= ((major) * 100 + (minor)))
#else
# define V8_GLIBC_PREREQ(major, minor) 0
#endif


// This macro allows to test for the version of the GNU C++ compiler.
// Note that this also applies to compilers that masquerade as GCC,
// for example clang and the Intel C++ compiler for Linux.
// Use like:
//  #if V8_GNUC_PREREQ(4, 3, 1)
//   ...
//  #endif
#if defined(__GNUC__) && defined(__GNUC_MINOR__) && defined(__GNUC_PATCHLEVEL__)
# define V8_GNUC_PREREQ(major, minor, patchlevel)                         \
    ((__GNUC__ * 10000 + __GNUC_MINOR__ * 100 + __GNUC_PATCHLEVEL__) >=   \
     ((major) * 10000 + (minor) * 100 + (patchlevel)))
#elif defined(__GNUC__) && defined(__GNUC_MINOR__)
# define V8_GNUC_PREREQ(major, minor, patchlevel)      \
    ((__GNUC__ * 10000 + __GNUC_MINOR__ * 100) >=      \
     ((major) * 10000 + (minor) * 100 + (patchlevel)))
#else
# define V8_GNUC_PREREQ(major, minor, patchlevel) 0
#endif



// -----------------------------------------------------------------------------
// Operating system detection (host)
//
//  V8_OS_ANDROID       - Android
//  V8_OS_BSD           - BSDish (macOS, Net/Free/Open/DragonFlyBSD)
//  V8_OS_CYGWIN        - Cygwin
//  V8_OS_DRAGONFLYBSD  - DragonFlyBSD
//  V8_OS_FREEBSD       - FreeBSD
//  V8_OS_FUCHSIA       - Fuchsia
//  V8_OS_LINUX         - Linux (Android, ChromeOS, Linux, ...)
//  V8_OS_DARWIN        - Darwin (macOS, iOS)
//  V8_OS_MACOS         - macOS
//  V8_OS_IOS           - iOS
//  V8_OS_NETBSD        - NetBSD
//  V8_OS_OPENBSD       - OpenBSD
//  V8_OS_POSIX         - POSIX compatible (mostly everything except Windows)
//  V8_OS_QNX           - QNX Neutrino
//  V8_OS_SOLARIS       - Sun Solaris and OpenSolaris
//  V8_OS_STARBOARD     - Starboard (platform abstraction for Cobalt)
//  V8_OS_AIX           - AIX
//  V8_OS_WIN           - Microsoft Windows

#if defined(__ANDROID__)
# define V8_OS_ANDROID 1
# define V8_OS_LINUX 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "android"

#elif defined(__APPLE__)
# define V8_OS_POSIX 1
# define V8_OS_BSD 1
# define V8_OS_DARWIN 1
# if defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE
#  define V8_OS_IOS 1
#  define V8_OS_STRING "ios"
# else
#  define V8_OS_MACOS 1
#  define V8_OS_STRING "macos"
# endif  // defined(TARGET_OS_IPHONE) && TARGET_OS_IPHONE

#elif defined(__CYGWIN__)
# define V8_OS_CYGWIN 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "cygwin"

#elif defined(__linux__)
# define V8_OS_LINUX 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "linux"

#elif defined(__sun)
# define V8_OS_POSIX 1
# define V8_OS_SOLARIS 1
# define V8_OS_STRING "sun"

#elif defined(STARBOARD)
# define V8_OS_STARBOARD 1
# define V8_OS_STRING "starboard"

#elif defined(_AIX)
# define V8_OS_POSIX 1
# define V8_OS_AIX 1
# define V8_OS_STRING "aix"

#elif defined(__FreeBSD__)
# define V8_OS_BSD 1
# define V8_OS_FREEBSD 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "freebsd"

#elif defined(__Fuchsia__)
# define V8_OS_FUCHSIA 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "fuchsia"

#elif defined(__DragonFly__)
# define V8_OS_BSD 1
# define V8_OS_DRAGONFLYBSD 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "dragonflybsd"

#elif defined(__NetBSD__)
# define V8_OS_BSD 1
# define V8_OS_NETBSD 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "netbsd"

#elif defined(__OpenBSD__)
# define V8_OS_BSD 1
# define V8_OS_OPENBSD 1
# define V8_OS_POSIX 1
# define V8_OS_STRING "openbsd"

#elif defined(__QNXNTO__)
# define V8_OS_POSIX 1
# define V8_OS_QNX 1
# define V8_OS_STRING "qnx"

#elif defined(_WIN32)
# define V8_OS_WIN 1
# define V8_OS_STRING "windows"
#endif

// -----------------------------------------------------------------------------
// Operating system detection (target)
//
//  V8_TARGET_OS_ANDROID
//  V8_TARGET_OS_FUCHSIA
//  V8_TARGET_OS_IOS
//  V8_TARGET_OS_LINUX
//  V8_TARGET_OS_MACOS
//  V8_TARGET_OS_WIN
//  V8_TARGET_OS_CHROMEOS
//
// If not set explicitly, these fall back to corresponding V8_OS_ values.

#ifdef V8_HAVE_TARGET_OS

// The target OS is provided, just check that at least one known value is set.
# if !defined(V8_TARGET_OS_ANDROID) \
  && !defined(V8_TARGET_OS_FUCHSIA) \
  && !defined(V8_TARGET_OS_IOS) \
  && !defined(V8_TARGET_OS_LINUX) \
  && !defined(V8_TARGET_OS_MACOS) \
  && !defined(V8_TARGET_OS_WIN) \
  && !defined(V8_TARGET_OS_CHROMEOS)
#  error No known target OS defined.
# endif

#else  // V8_HAVE_TARGET_OS

# if defined(V8_TARGET_OS_ANDROID) \
  || defined(V8_TARGET_OS_FUCHSIA) \
  || defined(V8_TARGET_OS_IOS) \
  || defined(V8_TARGET_OS_LINUX) \
  || defined(V8_TARGET_OS_MACOS) \
  || defined(V8_TARGET_OS_WIN) \
  || defined(V8_TARGET_OS_CHROMEOS)
#  error A target OS is defined but V8_HAVE_TARGET_OS is unset.
# endif

// Fall back to the detected host OS.
#ifdef V8_OS_ANDROID
# define V8_TARGET_OS_ANDROID
#endif

#ifdef V8_OS_FUCHSIA
# define V8_TARGET_OS_FUCHSIA
#endif

#ifdef V8_OS_IOS
# define V8_TARGET_OS_IOS
#endif

#ifdef V8_OS_LINUX
# define V8_TARGET_OS_LINUX
#endif

#ifdef V8_OS_MACOS
# define V8_TARGET_OS_MACOS
#endif

#ifdef V8_OS_WIN
# define V8_TARGET_OS_WIN
#endif

#endif  // V8_HAVE_TARGET_OS

#if defined(V8_TARGET_OS_ANDROID)
# define V8_TARGET_OS_STRING "android"
#elif defined(V8_TARGET_OS_FUCHSIA)
# define V8_TARGET_OS_STRING "fuchsia"
#elif defined(V8_TARGET_OS_IOS)
# define V8_TARGET_OS_STRING "ios"
#elif defined(V8_TARGET_OS_LINUX)
# define V8_TARGET_OS_STRING "linux"
#elif defined(V8_TARGET_OS_MACOS)
# define V8_TARGET_OS_STRING "macos"
#elif defined(V8_TARGET_OS_WINDOWS)
# define V8_TARGET_OS_STRING "windows"
#else
# define V8_TARGET_OS_STRING "unknown"
#endif

// -----------------------------------------------------------------------------
// C library detection
//
//  V8_LIBC_MSVCRT  - MSVC libc
//  V8_LIBC_BIONIC  - Bionic libc
//  V8_LIBC_BSD     - BSD libc derivate
//  V8_LIBC_GLIBC   - GNU C library
//  V8_LIBC_UCLIBC  - uClibc
//
// Note that testing for libc must be done using #if not #ifdef. For example,
// to test for the GNU C library, use:
//  #if V8_LIBC_GLIBC
//   ...
//  #endif

#if defined (_MSC_VER)
# define V8_LIBC_MSVCRT 1
#elif defined(__BIONIC__)
# define V8_LIBC_BIONIC 1
# define V8_LIBC_BSD 1
#elif defined(__UCLIBC__)
// Must test for UCLIBC before GLIBC, as UCLIBC pretends to be GLIBC.
# define V8_LIBC_UCLIBC 1
#elif defined(__GLIBC__) || defined(__GNU_LIBRARY__)
# define V8_LIBC_GLIBC 1
#else
# define V8_LIBC_BSD V8_OS_BSD
#endif


// -----------------------------------------------------------------------------
// Compiler detection
//
//  V8_CC_GNU     - GCC, or clang in gcc mode
//  V8_CC_INTEL   - Intel C++
//  V8_CC_MINGW   - Minimalist GNU for Windows
//  V8_CC_MINGW32 - Minimalist GNU for Windows (mingw32)
//  V8_CC_MINGW64 - Minimalist GNU for Windows (mingw-w64)
//  V8_CC_MSVC    - Microsoft Visual C/C++, or clang in cl.exe mode
//
// C++11 feature detection
//
// Compiler-specific feature detection
//
//  V8_HAS_ATTRIBUTE_ALWAYS_INLINE      - __attribute__((always_inline))
//                                        supported
//  V8_HAS_ATTRIBUTE_CONSTINIT          - __attribute__((require_constant_
//                                                       initialization))
//                                        supported
//  V8_HAS_ATTRIBUTE_NONNULL            - __attribute__((nonnull)) supported
//  V8_HAS_ATTRIBUTE_NOINLINE           - __attribute__((noinline)) supported
//  V8_HAS_ATTRIBUTE_UNUSED             - __attribute__((unused)) supported
//  V8_HAS_ATTRIBUTE_USED               - __attribute__((used)) supported
//  V8_HAS_ATTRIBUTE_RETAIN             - __attribute__((retain)) supported
//  V8_HAS_ATTRIBUTE_VISIBILITY         - __attribute__((visibility)) supported
//  V8_HAS_ATTRIBUTE_WARN_UNUSED_RESULT - __attribute__((warn_unused_result))
//                                        supported
//  V8_HAS_CPP_ATTRIBUTE_NODISCARD      - [[nodiscard]] supported
//  V8_HAS_CPP_ATTRIBUTE_NO_UNIQUE_ADDRESS
//                                      - [[no_unique_address]] supported
//  V8_HAS_BUILTIN_ADD_OVERFLOW         - __builtin_add_overflow() supported
//  V8_HAS_BUILTIN_BIT_CAST             - __builtin_bit_cast() supported
//  V8_HAS_BUILTIN_BSWAP16              - __builtin_bswap16() supported
//  V8_HAS_BUILTIN_BSWAP32              - __builtin_bswap32() supported
//  V8_HAS_BUILTIN_BSWAP64              - __builtin_bswap64() supported
//  V8_HAS_BUILTIN_CLZ                  - __builtin_clz() supported
//  V8_HAS_BUILTIN_CTZ                  - __builtin_ctz() supported
//  V8_HAS_BUILTIN_EXPECT               - __builtin_expect() supported
//  V8_HAS_BUILTIN_FRAME_ADDRESS        - __builtin_frame_address() supported
//  V8_HAS_BUILTIN_MUL_OVERFLOW         - __builtin_mul_overflow() supported
//  V8_HAS_BUILTIN_POPCOUNT             - __builtin_popcount() supported
//  V8_HAS_BUILTIN_SADD_OVERFLOW        - __builtin_sadd_overflow() supported
//  V8_HAS_BUILTIN_SMUL_OVERFLOW        - __builtin_smul_overflow() supported
//  V8_HAS_BUILTIN_SSUB_OVERFLOW        - __builtin_ssub_overflow() supported
//  V8_HAS_BUILTIN_SUB_OVERFLOW         - __builtin_sub_overflow() supported
//  V8_HAS_BUILTIN_UADD_OVERFLOW        - __builtin_uadd_overflow() supported
//  V8_HAS_COMPUTED_GOTO                - computed goto/labels as values
//                                        supported
//  V8_HAS_DECLSPEC_NOINLINE            - __declspec(noinline) supported
//  V8_HAS_DECLSPEC_SELECTANY           - __declspec(selectany) supported
//  V8_HAS___FORCEINLINE                - __forceinline supported
//
// Note that testing for compilers and/or features must be done using #if
// not #ifdef. For example, to test for Intel C++ Compiler, use:
//  #if V8_CC_INTEL
//   ...
//  #endif

#if defined(__has_cpp_attribute)
#define V8_HAS_CPP_ATTRIBUTE(FEATURE) __has_cpp_attribute(FEATURE)
#else
#define V8_HAS_CPP_ATTRIBUTE(FEATURE) 0
#endif

#if defined(__clang__)

#if defined(__GNUC__)  // Clang in gcc mode.
# define V8_CC_GNU 1
#endif

# define V8_HAS_ATTRIBUTE_ALWAYS_INLINE (__has_attribute(always_inline))
# define V8_HAS_ATTRIBUTE_CONSTINIT \
    (__has_attribute(require_constant_initialization))
# define V8_HAS_ATTRIBUTE_CONST (__has_attribute(const))
# define V8_HAS_ATTRIBUTE_NONNULL (__has_attribute(nonnull))
# define V8_HAS_ATTRIBUTE_NOINLINE (__has_attribute(noinline))
# define V8_HAS_ATTRIBUTE_UNUSED (__has_attribute(unused))
# define V8_HAS_ATTRIBUTE_USED (__has_attribute(used))
# define V8_HAS_ATTRIBUTE_RETAIN (__has_attribute(retain))
// Support for the "preserve_most" attribute is limited:
// - 32-bit platforms do not implement it,
// - component builds fail because _dl_runtime_resolve clobbers registers,
// - we see crashes on arm64 on Windows (https://crbug.com/1409934), which can
//   hopefully be fixed in the future.
// Additionally, the initial implementation in clang <= 16 overwrote the return
// register(s) in the epilogue of a preserve_most function, so we only use
// preserve_most in clang >= 17 (see https://reviews.llvm.org/D143425).
#if (defined(_M_X64) || defined(__x86_64__)            /* x64 (everywhere) */  \
     || ((defined(__AARCH64EL__) || defined(_M_ARM64)) /* arm64, but ... */    \
         && !defined(_WIN32)))                         /* not on windows */    \
     && !defined(COMPONENT_BUILD)                      /* no component build */\
     && __clang_major__ >= 17                          /* clang >= 17 */
# define V8_HAS_ATTRIBUTE_PRESERVE_MOST (__has_attribute(preserve_most))
#endif
# define V8_HAS_ATTRIBUTE_VISIBILITY (__has_attribute(visibility))
# define V8_HAS_ATTRIBUTE_WARN_UNUSED_RESULT \
    (__has_attribute(warn_unused_result))
# define V8_HAS_ATTRIBUTE_WEAK (__has_attribute(weak))

# define V8_HAS_CPP_ATTRIBUTE_NODISCARD (V8_HAS_CPP_ATTRIBUTE(nodiscard))
# define V8_HAS_CPP_ATTRIBUTE_NO_UNIQUE_ADDRESS \
    (V8_HAS_CPP_ATTRIBUTE(no_unique_address))

# define V8_HAS_BUILTIN_ADD_OVERFLOW (__has_builtin(__builtin_add_overflow))
# define V8_HAS_BUILTIN_ASSUME (__has_builtin(__builtin_assume))
# define V8_HAS_BUILTIN_ASSUME_ALIGNED (__has_builtin(__builtin_assume_aligned))
# define V8_HAS_BUILTIN_BIT_CAST (__has_builtin(__builtin_bit_cast))
# define V8_HAS_BUILTIN_BSWAP16 (__has_builtin(__builtin_bswap16))
# define V8_HAS_BUILTIN_BSWAP32 (__has_builtin(__builtin_bswap32))
# define V8_HAS_BUILTIN_BSWAP64 (__has_builtin(__builtin_bswap64))
# define V8_HAS_BUILTIN_CLZ (__has_builtin(__builtin_clz))
# define V8_HAS_BUILTIN_CTZ (__has_builtin(__builtin_ctz))
# define V8_HAS_BUILTIN_EXPECT (__has_builtin(__builtin_expect))
# define V8_HAS_BUILTIN_FRAME_ADDRESS (__has_builtin(__builtin_frame_address))
# define V8_HAS_BUILTIN_MUL_OVERFLOW (__has_builtin(__builtin_mul_overflow))
# define V8_HAS_BUILTIN_POPCOUNT (__has_builtin(__builtin_popcount))
# define V8_HAS_BUILTIN_SADD_OVERFLOW (__has_builtin(__builtin_sadd_overflow))
# define V8_HAS_BUILTIN_SMUL_OVERFLOW (__has_builtin(__builtin_smul_overflow))
# define V8_HAS_BUILTIN_SSUB_OVERFLOW (__has_builtin(__builtin_ssub_overflow))
# define V8_HAS_BUILTIN_SUB_OVERFLOW (__has_builtin(__builtin_sub_overflow))
# define V8_HAS_BUILTIN_UADD_OVERFLOW (__has_builtin(__builtin_uadd_overflow))
# define V8_HAS_BUILTIN_UNREACHABLE (__has_builtin(__builtin_unreachable))

// Clang has no __has_feature for computed gotos.
// GCC doc: https://gcc.gnu.org/onlinedocs/gcc/Labels-as-Values.html
# define V8_HAS_COMPUTED_GOTO 1

#elif defined(__GNUC__)

# define V8_CC_GNU 1
# if defined(__INTEL_COMPILER)  // Intel C++ also masquerades as GCC 3.2.0
#  define V8_CC_INTEL 1
# endif
# if defined(__MINGW32__)
#  define V8_CC_MINGW32 1
# endif
# if defined(__MINGW64__)
#  define V8_CC_MINGW64 1
# endif
# define V8_CC_MINGW (V8_CC_MINGW32 || V8_CC_MINGW64)

// FYI: __has_builtin is only available with GCC 10 and later, so explicitly
// check GCC version numbers to enable features. TODO(leszeks): Merge feature
// enabling for GCC 10 and later into the Clang section above, and leave this
// section for GCC 9 and earlier.

// always_inline is available in gcc 4.0 but not very reliable until 4.4.
// Works around "sorry, unimplemented: inlining failed" build errors with
// older compilers.
# define V8_HAS_ATTRIBUTE_ALWAYS_INLINE 1
# define V8_HAS_ATTRIBUTE_NOINLINE 1
# define V8_HAS_ATTRIBUTE_UNUSED 1
# define V8_HAS_ATTRIBUTE_VISIBILITY 1
# define V8_HAS_ATTRIBUTE_WARN_UNUSED_RESULT (!V8_CC_INTEL)
# define V8_HAS_ATTRIBUTE_WEAK 1

// [[nodiscard]] does not work together with with
// __attribute__((visibility(""))) on GCC 7.4 which is why there is no define
// for V8_HAS_CPP_ATTRIBUTE_NODISCARD. See https://crbug.com/v8/11707.

# define V8_HAS_BUILTIN_ASSUME_ALIGNED 1
# if __GNUC__ >= 11
#  define V8_HAS_BUILTIN_BIT_CAST 1
# endif
# define V8_HAS_BUILTIN_CLZ 1
# define V8_HAS_BUILTIN_CTZ 1
# define V8_HAS_BUILTIN_EXPECT 1
# define V8_HAS_BUILTIN_FRAME_ADDRESS 1
# define V8_HAS_BUILTIN_POPCOUNT 1
# define V8_HAS_BUILTIN_UNREACHABLE 1

// GCC doc: https://gcc.gnu.org/onlinedocs/gcc/Labels-as-Values.html
#define V8_HAS_COMPUTED_GOTO 1

#endif

#if defined(_MSC_VER)
# define V8_CC_MSVC 1

# define V8_HAS_DECLSPEC_NOINLINE 1
# define V8_HAS_DECLSPEC_SELECTANY 1

# define V8_HAS___FORCEINLINE 1

#endif


// -----------------------------------------------------------------------------
// Helper macros

// A macro used to make better inlining. Don't bother for debug builds.
// Use like:
//   V8_INLINE int GetZero() { return 0; }
#if !defined(DEBUG) && V8_HAS_ATTRIBUTE_ALWAYS_INLINE
# define V8_INLINE inline __attribute__((always_inline))
#elif !defined(DEBUG) && V8_HAS___FORCEINLINE
# define V8_INLINE __forceinline
#else
# define V8_INLINE inline
#endif

#ifdef DEBUG
// In debug mode, check assumptions instead of actually adding annotations.
# define V8_ASSUME DCHECK
#elif V8_HAS_BUILTIN_ASSUME
# define V8_ASSUME __builtin_assume
#elif V8_HAS_BUILTIN_UNREACHABLE
# define V8_ASSUME(condition)                  \
  do {                                         \
    if (!(condition)) __builtin_unreachable(); \
  } while (false)
#else
# define V8_ASSUME USE
#endif

// Prefer c++20 std::assume_aligned
#if __cplusplus >= 202002L && defined(__cpp_lib_assume_aligned)
# define V8_ASSUME_ALIGNED(ptr, alignment) \
  std::assume_aligned<(alignment)>(ptr)
#elif V8_HAS_BUILTIN_ASSUME_ALIGNED
# define V8_ASSUME_ALIGNED(ptr, alignment) \
  __builtin_assume_aligned((ptr), (alignment))
#else
# define V8_ASSUME_ALIGNED(ptr, alignment) (ptr)
#endif

// A macro to mark functions whose values don't change (e.g. across calls)
// and thereby compiler is free to hoist and fold multiple calls together.
// Use like:
//   V8_CONST int foo() { ... }
#if V8_HAS_ATTRIBUTE_CONST
# define V8_CONST __attribute__((const))
#else
# define V8_CONST
#endif

// A macro to mark a declaration as requiring constant initialization.
// Use like:
//   int* foo V8_CONSTINIT;
#if V8_HAS_ATTRIBUTE_CONSTINIT
# define V8_CONSTINIT __attribute__((require_constant_initialization))
#else
# define V8_CONSTINIT
#endif


// A macro to mark specific arguments as non-null.
// Use like:
//   int add(int* x, int y, int* z) V8_NONNULL(1, 3) { return *x + y + *z; }
#if V8_HAS_ATTRIBUTE_NONNULL
# define V8_NONNULL(...) __attribute__((nonnull(__VA_ARGS__)))
#else
# define V8_NONNULL(...) /* NOT SUPPORTED */
#endif


// A macro used to tell the compiler to never inline a particular function.
// Use like:
//   V8_NOINLINE int GetMinusOne() { return -1; }
#if V8_HAS_ATTRIBUTE_NOINLINE
# define V8_NOINLINE __attribute__((noinline))
#elif V8_HAS_DECLSPEC_NOINLINE
# define V8_NOINLINE __declspec(noinline)
#else
# define V8_NOINLINE /* NOT SUPPORTED */
#endif


// A macro used to change the calling conventions to preserve all registers (no
// caller-saved registers). Use this for cold functions called from hot
// functions.
// Use like:
//   V8_NOINLINE V8_PRESERVE_MOST void UnlikelyMethod();
#if V8_OS_WIN
# define V8_PRESERVE_MOST
#else
#if V8_HAS_ATTRIBUTE_PRESERVE_MOST
# define V8_PRESERVE_MOST __attribute__((preserve_most))
#else
# define V8_PRESERVE_MOST /* NOT SUPPORTED */
#endif
#endif


// A macro (V8_DEPRECATED) to mark classes or functions as deprecated.
#if defined(V8_DEPRECATION_WARNINGS)
# define V8_DEPRECATED(message) [[deprecated(message)]]
#else
# define V8_DEPRECATED(message)
#endif


// A macro (V8_DEPRECATE_SOON) to make it easier to see what will be deprecated.
#if defined(V8_IMMINENT_DEPRECATION_WARNINGS)
# define V8_DEPRECATE_SOON(message) [[deprecated(message)]]
#else
# define V8_DEPRECATE_SOON(message)
#endif


#if defined(V8_IMMINENT_DEPRECATION_WARNINGS) || \
    defined(V8_DEPRECATION_WARNINGS)
#if defined(V8_CC_MSVC)
# define START_ALLOW_USE_DEPRECATED() \
    __pragma(warning(push))           \
    __pragma(warning(disable : 4996))
# define END_ALLOW_USE_DEPRECATED() __pragma(warning(pop))
#else  // !defined(V8_CC_MSVC)
# define START_ALLOW_USE_DEPRECATED()                               \
    _Pragma("GCC diagnostic push")                                  \
    _Pragma("GCC diagnostic ignored \"-Wdeprecated-declarations\"")
#define END_ALLOW_USE_DEPRECATED() _Pragma("GCC diagnostic pop")
#endif  // !defined(V8_CC_MSVC)
#else  // !(defined(V8_IMMINENT_DEPRECATION_WARNINGS) ||
       // defined(V8_DEPRECATION_WARNINGS))
#define START_ALLOW_USE_DEPRECATED()
#define END_ALLOW_USE_DEPRECATED()
#endif  // !(defined(V8_IMMINENT_DEPRECATION_WARNINGS) ||
        // defined(V8_DEPRECATION_WARNINGS))
#define ALLOW_COPY_AND_MOVE_WITH_DEPRECATED_FIELDS(ClassName) \
  START_ALLOW_USE_DEPRECATED()                                \
  ClassName(const ClassName&) = default;                      \
  ClassName(ClassName&&) = default;                           \
  ClassName& operator=(const ClassName&) = default;           \
  ClassName& operator=(ClassName&&) = default;                \
  END_ALLOW_USE_DEPRECATED()


#if defined(__GNUC__) && !defined(__clang__) && (__GNUC__ < 6)
# define V8_ENUM_DEPRECATED(message)
# define V8_ENUM_DEPRECATE_SOON(message)
#else
# define V8_ENUM_DEPRECATED(message) V8_DEPRECATED(message)
# define V8_ENUM_DEPRECATE_SOON(message) V8_DEPRECATE_SOON(message)
#endif


// A macro to provide the compiler with branch prediction information.
#if V8_HAS_BUILTIN_EXPECT
# define V8_UNLIKELY(condition) (__builtin_expect(!!(condition), 0))
# define V8_LIKELY(condition) (__builtin_expect(!!(condition), 1))
#else
# define V8_UNLIKELY(condition) (condition)
# define V8_LIKELY(condition) (condition)
#endif


// Annotate a function indicating the caller must examine the return value.
// Use like:
//   int foo() V8_WARN_UNUSED_RESULT;
#if V8_HAS_ATTRIBUTE_WARN_UNUSED_RESULT
#define V8_WARN_UNUSED_RESULT __attribute__((warn_unused_result))
#else
#define V8_WARN_UNUSED_RESULT /* NOT SUPPORTED */
#endif


// Annotate functions/variables as weak to allow overriding the symbol.
#if V8_HAS_ATTRIBUTE_WEAK
#define V8_WEAK __attribute__((weak))
#else
#define V8_WEAK /* NOT SUPPORTED */
#endif


// Annotate a class or constructor indicating the caller must assign the
// constructed instances.
// Apply to the whole class like:
//   class V8_NODISCARD Foo() { ... };
// or apply to just one constructor like:
//   V8_NODISCARD Foo() { ... };
// [[nodiscard]] comes in C++17 but supported in clang with -std >= c++11.
#if V8_HAS_CPP_ATTRIBUTE_NODISCARD
#define V8_NODISCARD [[nodiscard]]
#else
#define V8_NODISCARD /* NOT SUPPORTED */
#endif

// The no_unique_address attribute allows tail padding in a non-static data
// member to overlap other members of the enclosing class (and in the special
// case when the type is empty, permits it to fully overlap other members). The
// field is laid out as if a base class were encountered at the corresponding
// point within the class (except that it does not share a vptr with the
// enclosing object).
//
// Apply to a data member like:
//
//   class Foo {
//    V8_NO_UNIQUE_ADDRESS Bar bar_;
//   };
//
// [[no_unique_address]] comes in C++20 but supported in clang with
// -std >= c++11.
#if V8_HAS_CPP_ATTRIBUTE_NO_UNIQUE_ADDRESS
#define V8_NO_UNIQUE_ADDRESS [[no_unique_address]]
#else
#define V8_NO_UNIQUE_ADDRESS /* NOT SUPPORTED */
#endif

// Marks a type as being eligible for the "trivial" ABI despite having a
// non-trivial destructor or copy/move constructor. Such types can be relocated
// after construction by simply copying their memory, which makes them eligible
// to be passed in registers. The canonical example is std::unique_ptr.
//
// Use with caution; this has some subtle effects on constructor/destructor
// ordering and will be very incorrect if the type relies on its address
// remaining constant. When used as a function argument (by value), the value
// may be constructed in the caller's stack frame, passed in a register, and
// then used and destructed in the callee's stack frame. A similar thing can
// occur when values are returned.
//
// TRIVIAL_ABI is not needed for types which have a trivial destructor and
// copy/move constructors, since those are automatically trivial by the ABI
// spec.
//
// It is also not likely to be effective on types too large to be passed in one
// or two registers on typical target ABIs.
//
// See also:
//   https://clang.llvm.org/docs/AttributeReference.html#trivial-abi
//   https://libcxx.llvm.org/docs/DesignDocs/UniquePtrTrivialAbi.html
#if defined(__clang__) && defined(__has_attribute)
#if __has_attribute(trivial_abi)
#define V8_TRIVIAL_ABI [[clang::trivial_abi]]
#define V8_HAS_ATTRIBUTE_TRIVIAL_ABI 1
#endif // __has_attribute(trivial_abi)
#endif // defined(__clang__) && defined(__has_attribute)
#if !defined(V8_TRIVIAL_ABI)
#define V8_TRIVIAL_ABI
#define V8_HAS_ATTRIBUTE_TRIVIAL_ABI 0
#endif //!defined(V8_TRIVIAL_ABI)

// Helper macro to define no_sanitize attributes only with clang.
#if defined(__clang__) && defined(__has_attribute)
#if __has_attribute(no_sanitize)
#define V8_CLANG_NO_SANITIZE(what) __attribute__((no_sanitize(what)))
#endif
#endif
#if !defined(V8_CLANG_NO_SANITIZE)
#define V8_CLANG_NO_SANITIZE(what)
#endif

// Exposing private symbols requires exposing public symbols too.
#ifdef BUILDING_V8_SHARED_PRIVATE
#define BUILDING_V8_SHARED
#endif

#if defined(BUILDING_V8_SHARED) && defined(USING_V8_SHARED)
#error Inconsistent build configuration: To build the V8 shared library \
set BUILDING_V8_SHARED, to include its headers for linking against the \
V8 shared library set USING_V8_SHARED.
#endif

#ifdef V8_OS_WIN

// Setup for Windows DLL export/import. When building the V8 DLL the
// BUILDING_V8_SHARED needs to be defined. When building a program which uses
// the V8 DLL USING_V8_SHARED needs to be defined. When either building the V8
// static library or building a program which uses the V8 static library neither
// BUILDING_V8_SHARED nor USING_V8_SHARED should be defined.
#ifdef BUILDING_V8_SHARED
# define V8_EXPORT __declspec(dllexport)
#elif USING_V8_SHARED
# define V8_EXPORT __declspec(dllimport)
#else
# define V8_EXPORT
#endif  // BUILDING_V8_SHARED

#else  // V8_OS_WIN

// Setup for Linux shared library export.
#if V8_HAS_ATTRIBUTE_VISIBILITY
# ifdef BUILDING_V8_SHARED
#  define V8_EXPORT __attribute__ ((visibility("default")))
# else
#  define V8_EXPORT
# endif
#else
# define V8_EXPORT
#endif

#endif  // V8_OS_WIN

// clang-format on

// Processor architecture detection.  For more info on what's defined, see:
//   http://msdn.microsoft.com/en-us/library/b0084kay.aspx
//   http://www.agner.org/optimize/calling_conventions.pdf
//   or with gcc, run: "echo | gcc -E -dM -"
// The V8_HOST_ARCH_* macros correspond to the architecture on which V8, as a
// virtual machine and compiler, runs. Don't confuse this with the architecture
// on which V8 is built.
#if defined(_M_X64) || defined(__x86_64__)
#define V8_HOST_ARCH_X64 1
#if defined(__x86_64__) && __SIZEOF_POINTER__ == 4  // Check for x32.
#define V8_HOST_ARCH_32_BIT 1
#else
#define V8_HOST_ARCH_64_BIT 1
#endif
#elif defined(_M_IX86) || defined(__i386__)
#define V8_HOST_ARCH_IA32 1
#define V8_HOST_ARCH_32_BIT 1
#elif defined(__AARCH64EL__) || defined(_M_ARM64)
#define V8_HOST_ARCH_ARM64 1
#define V8_HOST_ARCH_64_BIT 1
#elif defined(__ARMEL__)
#define V8_HOST_ARCH_ARM 1
#define V8_HOST_ARCH_32_BIT 1
#elif defined(__mips64)
#define V8_HOST_ARCH_MIPS64 1
#define V8_HOST_ARCH_64_BIT 1
#elif defined(__loongarch_lp64)
#define V8_HOST_ARCH_LOONG64 1
#define V8_HOST_ARCH_64_BIT 1
#elif defined(__PPC64__) || defined(_ARCH_PPC64)
#define V8_HOST_ARCH_PPC64 1
#define V8_HOST_ARCH_64_BIT 1
#elif defined(__PPC__) || defined(_ARCH_PPC)
#define V8_HOST_ARCH_PPC 1
#define V8_HOST_ARCH_32_BIT 1
#elif defined(__s390__) || defined(__s390x__)
#define V8_HOST_ARCH_S390 1
#if defined(__s390x__)
#define V8_HOST_ARCH_64_BIT 1
#else
#define V8_HOST_ARCH_32_BIT 1
#endif
#elif defined(__riscv) || defined(__riscv__)
#if __riscv_xlen == 64
#define V8_HOST_ARCH_RISCV64 1
#define V8_HOST_ARCH_64_BIT 1
#elif __riscv_xlen == 32
#define V8_HOST_ARCH_RISCV32 1
#define V8_HOST_ARCH_32_BIT 1
#else
#error "Cannot detect Riscv's bitwidth"
#endif
#else
#error "Host architecture was not detected as supported by v8"
#endif

// Target architecture detection. This corresponds to the architecture for which
// V8's JIT will generate code (the last stage of the canadian cross-compiler).
// The macros may be set externally. If not, detect in the same way as the host
// architecture, that is, target the native environment as presented by the
// compiler.
#if !V8_TARGET_ARCH_X64 && !V8_TARGET_ARCH_IA32 && !V8_TARGET_ARCH_ARM &&     \
    !V8_TARGET_ARCH_ARM64 && !V8_TARGET_ARCH_MIPS64 && !V8_TARGET_ARCH_PPC && \
    !V8_TARGET_ARCH_PPC64 && !V8_TARGET_ARCH_S390 &&                          \
    !V8_TARGET_ARCH_RISCV64 && !V8_TARGET_ARCH_LOONG64 &&                     \
    !V8_TARGET_ARCH_RISCV32
#if defined(_M_X64) || defined(__x86_64__)
#define V8_TARGET_ARCH_X64 1
#elif defined(_M_IX86) || defined(__i386__)
#define V8_TARGET_ARCH_IA32 1
#elif defined(__AARCH64EL__) || defined(_M_ARM64)
#define V8_TARGET_ARCH_ARM64 1
#elif defined(__ARMEL__)
#define V8_TARGET_ARCH_ARM 1
#elif defined(__mips64)
#define V8_TARGET_ARCH_MIPS64 1
#elif defined(__loongarch_lp64)
#define V8_TARGET_ARCH_LOONG64 1
#elif defined(_ARCH_PPC64)
#define V8_TARGET_ARCH_PPC64 1
#elif defined(_ARCH_PPC)
#define V8_TARGET_ARCH_PPC 1
#elif defined(__s390__)
#define V8_TARGET_ARCH_S390 1
#if defined(__s390x__)
#define V8_TARGET_ARCH_S390X 1
#endif
#elif defined(__riscv) || defined(__riscv__)
#if __riscv_xlen == 64
#define V8_TARGET_ARCH_RISCV64 1
#elif __riscv_xlen == 32
#define V8_TARGET_ARCH_RISCV32 1
#endif
#else
#error Target architecture was not detected as supported by v8
#endif
#endif

// Determine architecture pointer size.
#if V8_TARGET_ARCH_IA32
#define V8_TARGET_ARCH_32_BIT 1
#elif V8_TARGET_ARCH_X64
#if !V8_TARGET_ARCH_32_BIT && !V8_TARGET_ARCH_64_BIT
#if defined(__x86_64__) && __SIZEOF_POINTER__ == 4  // Check for x32.
#define V8_TARGET_ARCH_32_BIT 1
#else
#define V8_TARGET_ARCH_64_BIT 1
#endif
#endif
#elif V8_TARGET_ARCH_ARM
#define V8_TARGET_ARCH_32_BIT 1
#elif V8_TARGET_ARCH_ARM64
#define V8_TARGET_ARCH_64_BIT 1
#elif V8_TARGET_ARCH_MIPS
#define V8_TARGET_ARCH_32_BIT 1
#elif V8_TARGET_ARCH_MIPS64
#define V8_TARGET_ARCH_64_BIT 1
#elif V8_TARGET_ARCH_LOONG64
#define V8_TARGET_ARCH_64_BIT 1
#elif V8_TARGET_ARCH_PPC
#define V8_TARGET_ARCH_32_BIT 1
#elif V8_TARGET_ARCH_PPC64
#define V8_TARGET_ARCH_64_BIT 1
#elif V8_TARGET_ARCH_S390
#if V8_TARGET_ARCH_S390X
#define V8_TARGET_ARCH_64_BIT 1
#else
#define V8_TARGET_ARCH_32_BIT 1
#endif
#elif V8_TARGET_ARCH_RISCV64
#define V8_TARGET_ARCH_64_BIT 1
#elif V8_TARGET_ARCH_RISCV32
#define V8_TARGET_ARCH_32_BIT 1
#else
#error Unknown target architecture pointer size
#endif

// Check for supported combinations of host and target architectures.
#if V8_TARGET_ARCH_IA32 && !V8_HOST_ARCH_IA32
#error Target architecture ia32 is only supported on ia32 host
#endif
#if (V8_TARGET_ARCH_X64 && V8_TARGET_ARCH_64_BIT && \
     !((V8_HOST_ARCH_X64 || V8_HOST_ARCH_ARM64) && V8_HOST_ARCH_64_BIT))
#error Target architecture x64 is only supported on x64 and arm64 host
#endif
#if (V8_TARGET_ARCH_X64 && V8_TARGET_ARCH_32_BIT && \
     !(V8_HOST_ARCH_X64 && V8_HOST_ARCH_32_BIT))
#error Target architecture x32 is only supported on x64 host with x32 support
#endif
#if (V8_TARGET_ARCH_ARM && !(V8_HOST_ARCH_IA32 || V8_HOST_ARCH_ARM))
#error Target architecture arm is only supported on arm and ia32 host
#endif
#if (V8_TARGET_ARCH_ARM64 && !(V8_HOST_ARCH_X64 || V8_HOST_ARCH_ARM64))
#error Target architecture arm64 is only supported on arm64 and x64 host
#endif
#if (V8_TARGET_ARCH_MIPS64 && !(V8_HOST_ARCH_X64 || V8_HOST_ARCH_MIPS64))
#error Target architecture mips64 is only supported on mips64 and x64 host
#endif
#if (V8_TARGET_ARCH_RISCV64 && !(V8_HOST_ARCH_X64 || V8_HOST_ARCH_RISCV64))
#error Target architecture riscv64 is only supported on riscv64 and x64 host
#endif
#if (V8_TARGET_ARCH_RISCV32 && !(V8_HOST_ARCH_IA32 || V8_HOST_ARCH_RISCV32))
#error Target architecture riscv32 is only supported on riscv32 and ia32 host
#endif
#if (V8_TARGET_ARCH_LOONG64 && !(V8_HOST_ARCH_X64 || V8_HOST_ARCH_LOONG64))
#error Target architecture loong64 is only supported on loong64 and x64 host
#endif

// Determine architecture endianness.
#if V8_TARGET_ARCH_IA32
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_X64
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_ARM
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_ARM64
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_LOONG64
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_MIPS64
#if defined(__MIPSEB__) || defined(V8_TARGET_ARCH_MIPS64_BE)
#define V8_TARGET_BIG_ENDIAN 1
#else
#define V8_TARGET_LITTLE_ENDIAN 1
#endif
#elif defined(__BIG_ENDIAN__)  // FOR PPCGR on AIX
#define V8_TARGET_BIG_ENDIAN 1
#elif V8_TARGET_ARCH_PPC_LE
#define V8_TARGET_LITTLE_ENDIAN 1
#elif V8_TARGET_ARCH_PPC_BE
#define V8_TARGET_BIG_ENDIAN 1
#elif V8_TARGET_ARCH_S390
#if V8_TARGET_ARCH_S390_LE_SIM
#define V8_TARGET_LITTLE_ENDIAN 1
#else
#define V8_TARGET_BIG_ENDIAN 1
#endif
#elif V8_TARGET_ARCH_RISCV32 || V8_TARGET_ARCH_RISCV64
#define V8_TARGET_LITTLE_ENDIAN 1
#elif defined(__BYTE_ORDER__)
#if __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
#define V8_TARGET_BIG_ENDIAN 1
#else
#define V8_TARGET_LITTLE_ENDIAN 1
#endif
#else
#error Unknown target architecture endianness
#endif

#undef V8_HAS_CPP_ATTRIBUTE

#if !defined(V8_STATIC_ROOTS)
#define V8_STATIC_ROOTS_BOOL false
#else
#define V8_STATIC_ROOTS_BOOL true
#endif

#endif  // V8CONFIG_H_
