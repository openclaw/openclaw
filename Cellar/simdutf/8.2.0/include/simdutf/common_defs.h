#ifndef SIMDUTF_COMMON_DEFS_H
#define SIMDUTF_COMMON_DEFS_H

#include "simdutf/portability.h"
#include "simdutf/avx512.h"

// Sometimes logging is useful, but we want it disabled by default
// and free of any logging code in release builds.
#ifdef SIMDUTF_LOGGING
  #include <iostream>
  #define simdutf_log(msg)                                                     \
    std::cout << "[" << __FUNCTION__ << "]: " << msg << std::endl              \
              << "\t" << __FILE__ << ":" << __LINE__ << std::endl;
  #define simdutf_log_assert(cond, msg)                                        \
    do {                                                                       \
      if (!(cond)) {                                                           \
        std::cerr << "[" << __FUNCTION__ << "]: " << msg << std::endl          \
                  << "\t" << __FILE__ << ":" << __LINE__ << std::endl;         \
        std::abort();                                                          \
      }                                                                        \
    } while (0)
#else
  #define simdutf_log(msg)
  #define simdutf_log_assert(cond, msg)
#endif

#if defined(SIMDUTF_REGULAR_VISUAL_STUDIO)
  #define SIMDUTF_DEPRECATED __declspec(deprecated)

  #define simdutf_really_inline __forceinline // really inline in release mode
  #define simdutf_always_inline __forceinline // always inline, no matter what
  #define simdutf_never_inline __declspec(noinline)

  #define simdutf_unused
  #define simdutf_warn_unused

  #ifndef simdutf_likely
    #define simdutf_likely(x) x
  #endif
  #ifndef simdutf_unlikely
    #define simdutf_unlikely(x) x
  #endif

  #define SIMDUTF_PUSH_DISABLE_WARNINGS __pragma(warning(push))
  #define SIMDUTF_PUSH_DISABLE_ALL_WARNINGS __pragma(warning(push, 0))
  #define SIMDUTF_DISABLE_VS_WARNING(WARNING_NUMBER)                           \
    __pragma(warning(disable : WARNING_NUMBER))
  // Get rid of Intellisense-only warnings (Code Analysis)
  // Though __has_include is C++17, it is supported in Visual Studio 2017 or
  // better (_MSC_VER>=1910).
  #ifdef __has_include
    #if __has_include(<CppCoreCheck\Warnings.h>)
      #include <CppCoreCheck\Warnings.h>
      #define SIMDUTF_DISABLE_UNDESIRED_WARNINGS                               \
        SIMDUTF_DISABLE_VS_WARNING(ALL_CPPCORECHECK_WARNINGS)
    #endif
  #endif

  #ifndef SIMDUTF_DISABLE_UNDESIRED_WARNINGS
    #define SIMDUTF_DISABLE_UNDESIRED_WARNINGS
  #endif

  #define SIMDUTF_DISABLE_DEPRECATED_WARNING SIMDUTF_DISABLE_VS_WARNING(4996)
  #define SIMDUTF_DISABLE_STRICT_OVERFLOW_WARNING
  #define SIMDUTF_POP_DISABLE_WARNINGS __pragma(warning(pop))
  #define SIMDUTF_DISABLE_UNUSED_WARNING
#else // SIMDUTF_REGULAR_VISUAL_STUDIO
  #if defined(__OPTIMIZE__) || defined(NDEBUG)
    #define simdutf_really_inline inline __attribute__((always_inline))
  #else
    #define simdutf_really_inline inline
  #endif
  #define simdutf_always_inline                                                \
    inline __attribute__((always_inline)) // always inline, no matter what
  #define SIMDUTF_DEPRECATED __attribute__((deprecated))
  #define simdutf_never_inline inline __attribute__((noinline))

  #define simdutf_unused __attribute__((unused))
  #define simdutf_warn_unused __attribute__((warn_unused_result))

  #ifndef simdutf_likely
    #define simdutf_likely(x) __builtin_expect(!!(x), 1)
  #endif
  #ifndef simdutf_unlikely
    #define simdutf_unlikely(x) __builtin_expect(!!(x), 0)
  #endif
  // clang-format off
  #define SIMDUTF_PUSH_DISABLE_WARNINGS _Pragma("GCC diagnostic push")
  // gcc doesn't seem to disable all warnings with all and extra, add warnings
  // here as necessary
  #define SIMDUTF_PUSH_DISABLE_ALL_WARNINGS                                    \
    SIMDUTF_PUSH_DISABLE_WARNINGS                                              \
    SIMDUTF_DISABLE_GCC_WARNING(-Weffc++)                                      \
    SIMDUTF_DISABLE_GCC_WARNING(-Wall)                                         \
    SIMDUTF_DISABLE_GCC_WARNING(-Wconversion)                                  \
    SIMDUTF_DISABLE_GCC_WARNING(-Wextra)                                       \
    SIMDUTF_DISABLE_GCC_WARNING(-Wattributes)                                  \
    SIMDUTF_DISABLE_GCC_WARNING(-Wimplicit-fallthrough)                        \
    SIMDUTF_DISABLE_GCC_WARNING(-Wnon-virtual-dtor)                            \
    SIMDUTF_DISABLE_GCC_WARNING(-Wreturn-type)                                 \
    SIMDUTF_DISABLE_GCC_WARNING(-Wshadow)                                      \
    SIMDUTF_DISABLE_GCC_WARNING(-Wunused-parameter)                            \
    SIMDUTF_DISABLE_GCC_WARNING(-Wunused-variable)
  #define SIMDUTF_PRAGMA(P) _Pragma(#P)
  #define SIMDUTF_DISABLE_GCC_WARNING(WARNING)                                 \
    SIMDUTF_PRAGMA(GCC diagnostic ignored #WARNING)
  #if defined(SIMDUTF_CLANG_VISUAL_STUDIO)
    #define SIMDUTF_DISABLE_UNDESIRED_WARNINGS                                 \
      SIMDUTF_DISABLE_GCC_WARNING(-Wmicrosoft-include)
  #else
    #define SIMDUTF_DISABLE_UNDESIRED_WARNINGS
  #endif
  #define SIMDUTF_DISABLE_DEPRECATED_WARNING                                   \
    SIMDUTF_DISABLE_GCC_WARNING(-Wdeprecated-declarations)
  #define SIMDUTF_DISABLE_STRICT_OVERFLOW_WARNING                              \
    SIMDUTF_DISABLE_GCC_WARNING(-Wstrict-overflow)
  #define SIMDUTF_POP_DISABLE_WARNINGS _Pragma("GCC diagnostic pop")
  #define SIMDUTF_DISABLE_UNUSED_WARNING                                       \
    SIMDUTF_PUSH_DISABLE_WARNINGS                                              \
    SIMDUTF_DISABLE_GCC_WARNING(-Wunused-function)                             \
    SIMDUTF_DISABLE_GCC_WARNING(-Wunused-const-variable)
  // clang-format on

#endif // MSC_VER

// Conditional constexpr macro: expands to constexpr for C++17+, empty otherwise
#if SIMDUTF_CPLUSPLUS17
  #define simdutf_constexpr constexpr
#else
  #define simdutf_constexpr
#endif

// Will evaluate to constexpr in C++23 or later. This makes it possible to mark
// functions constexpr if the "if consteval" feature is available to use.
#if SIMDUTF_CPLUSPLUS23
  #define simdutf_constexpr23 constexpr
#else
  #define simdutf_constexpr23
#endif

#ifndef SIMDUTF_DLLIMPORTEXPORT
  #if defined(SIMDUTF_VISUAL_STUDIO) // Visual Studio
                                     /**
                                      * Windows users need to do some extra work when building
                                      * or using a dynamic library (DLL). When building, we need
                                      * to set SIMDUTF_DLLIMPORTEXPORT to __declspec(dllexport).
                                      * When *using* the DLL, the user needs to set
                                      * SIMDUTF_DLLIMPORTEXPORT __declspec(dllimport).
                                      *
                                      * Static libraries not need require such work.
                                      *
                                      * It does not matter here whether you are using
                                      * the regular visual studio or clang under visual
                                      * studio, you still need to handle these issues.
                                      *
                                      * Non-Windows systems do not have this complexity.
                                      */
    #if SIMDUTF_BUILDING_WINDOWS_DYNAMIC_LIBRARY

      // We set SIMDUTF_BUILDING_WINDOWS_DYNAMIC_LIBRARY when we build a DLL
      // under Windows. It should never happen that both
      // SIMDUTF_BUILDING_WINDOWS_DYNAMIC_LIBRARY and
      // SIMDUTF_USING_WINDOWS_DYNAMIC_LIBRARY are set.
      #define SIMDUTF_DLLIMPORTEXPORT __declspec(dllexport)
    #elif SIMDUTF_USING_WINDOWS_DYNAMIC_LIBRARY
      // Windows user who call a dynamic library should set
      // SIMDUTF_USING_WINDOWS_DYNAMIC_LIBRARY to 1.

      #define SIMDUTF_DLLIMPORTEXPORT __declspec(dllimport)
    #else
      // We assume by default static linkage
      #define SIMDUTF_DLLIMPORTEXPORT
    #endif
  #else // defined(SIMDUTF_VISUAL_STUDIO)
    // Non-Windows systems do not have this complexity.
    #define SIMDUTF_DLLIMPORTEXPORT
  #endif // defined(SIMDUTF_VISUAL_STUDIO)
#endif

#if SIMDUTF_MAYBE_UNUSED_AVAILABLE
  #define simdutf_maybe_unused [[maybe_unused]]
#else
  #define simdutf_maybe_unused
#endif

#endif // SIMDUTF_COMMON_DEFS_H
