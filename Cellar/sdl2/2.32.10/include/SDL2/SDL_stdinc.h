/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

/* WIKI CATEGORY: StdInc */

/**
 * # CategoryStdInc
 *
 * This is a general header that includes C language support.
 */

#ifndef SDL_stdinc_h_
#define SDL_stdinc_h_

#include "SDL_config.h"

#ifdef HAVE_SYS_TYPES_H
#include <sys/types.h>
#endif
#ifdef HAVE_STDIO_H
#include <stdio.h>
#endif
#if defined(STDC_HEADERS)
# include <stdlib.h>
# include <stddef.h>
# include <stdarg.h>
#else
# if defined(HAVE_STDLIB_H)
#  include <stdlib.h>
# elif defined(HAVE_MALLOC_H)
#  include <malloc.h>
# endif
# if defined(HAVE_STDDEF_H)
#  include <stddef.h>
# endif
# if defined(HAVE_STDARG_H)
#  include <stdarg.h>
# endif
#endif
#ifdef HAVE_STRING_H
# if !defined(STDC_HEADERS) && defined(HAVE_MEMORY_H)
#  include <memory.h>
# endif
# include <string.h>
#endif
#ifdef HAVE_STRINGS_H
# include <strings.h>
#endif
#ifdef HAVE_WCHAR_H
# include <wchar.h>
#endif
#if defined(HAVE_INTTYPES_H)
# include <inttypes.h>
#elif defined(HAVE_STDINT_H)
# include <stdint.h>
#endif
#ifdef HAVE_CTYPE_H
# include <ctype.h>
#endif
#ifdef HAVE_MATH_H
# if defined(_MSC_VER)
/* Defining _USE_MATH_DEFINES is required to get M_PI to be defined on
   Visual Studio.  See http://msdn.microsoft.com/en-us/library/4hwaceh6.aspx
   for more information.
*/
#  ifndef _USE_MATH_DEFINES
#    define _USE_MATH_DEFINES
#  endif
# endif
# include <math.h>
#endif
#ifdef HAVE_FLOAT_H
# include <float.h>
#endif
#if defined(HAVE_ALLOCA) && !defined(alloca)
# if defined(HAVE_ALLOCA_H)
#  include <alloca.h>
# elif defined(__GNUC__)
#  define alloca __builtin_alloca
# elif defined(_MSC_VER)
#  include <malloc.h>
#  define alloca _alloca
# elif defined(__WATCOMC__)
#  include <malloc.h>
# elif defined(__BORLANDC__)
#  include <malloc.h>
# elif defined(__DMC__)
#  include <stdlib.h>
# elif defined(__AIX__)
#pragma alloca
# elif defined(__MRC__)
void *alloca(unsigned);
# else
void *alloca(size_t);
# endif
#endif

#ifdef SIZE_MAX
# define SDL_SIZE_MAX SIZE_MAX
#else
# define SDL_SIZE_MAX ((size_t) -1)
#endif

/**
 * Check if the compiler supports a given builtin.
 * Supported by virtually all clang versions and recent gcc. Use this
 * instead of checking the clang version if possible.
 */
#ifdef __has_builtin
#define _SDL_HAS_BUILTIN(x) __has_builtin(x)
#else
#define _SDL_HAS_BUILTIN(x) 0
#endif

/**
 * The number of elements in an array.
 */
#define SDL_arraysize(array)    (sizeof(array)/sizeof(array[0]))
#define SDL_TABLESIZE(table)    SDL_arraysize(table)

/**
 * Macro useful for building other macros with strings in them
 *
 * e.g:
 *
 * ```c
 * #define LOG_ERROR(X) OutputDebugString(SDL_STRINGIFY_ARG(__FUNCTION__) ": " X "\n")
 * ```
 */
#define SDL_STRINGIFY_ARG(arg)  #arg

/**
 *  \name Cast operators
 *
 *  Use proper C++ casts when compiled as C++ to be compatible with the option
 *  -Wold-style-cast of GCC (and -Werror=old-style-cast in GCC 4.2 and above).
 */
/* @{ */
#ifdef __cplusplus
#define SDL_reinterpret_cast(type, expression) reinterpret_cast<type>(expression)
#define SDL_static_cast(type, expression) static_cast<type>(expression)
#define SDL_const_cast(type, expression) const_cast<type>(expression)
#else
#define SDL_reinterpret_cast(type, expression) ((type)(expression))
#define SDL_static_cast(type, expression) ((type)(expression))
#define SDL_const_cast(type, expression) ((type)(expression))
#endif
/* @} *//* Cast operators */

/* Define a four character code as a Uint32 */
#define SDL_FOURCC(A, B, C, D) \
    ((SDL_static_cast(Uint32, SDL_static_cast(Uint8, (A))) << 0) | \
     (SDL_static_cast(Uint32, SDL_static_cast(Uint8, (B))) << 8) | \
     (SDL_static_cast(Uint32, SDL_static_cast(Uint8, (C))) << 16) | \
     (SDL_static_cast(Uint32, SDL_static_cast(Uint8, (D))) << 24))

/**
 *  \name Basic data types
 */
/* @{ */

#ifdef __CC_ARM
/* ARM's compiler throws warnings if we use an enum: like "SDL_bool x = a < b;" */
#define SDL_FALSE 0
#define SDL_TRUE 1
typedef int SDL_bool;
#else
typedef enum
{
    SDL_FALSE = 0,
    SDL_TRUE = 1
} SDL_bool;
#endif

/**
 * A signed 8-bit integer type.
 */
typedef int8_t Sint8;
#define SDL_MAX_SINT8   ((Sint8)0x7F)           /* 127 */
#define SDL_MIN_SINT8   ((Sint8)(~0x7F))        /* -128 */

/**
 * An unsigned 8-bit integer type.
 */
typedef uint8_t Uint8;
#define SDL_MAX_UINT8   ((Uint8)0xFF)           /* 255 */
#define SDL_MIN_UINT8   ((Uint8)0x00)           /* 0 */

/**
 * A signed 16-bit integer type.
 */
typedef int16_t Sint16;
#define SDL_MAX_SINT16  ((Sint16)0x7FFF)        /* 32767 */
#define SDL_MIN_SINT16  ((Sint16)(~0x7FFF))     /* -32768 */

/**
 * An unsigned 16-bit integer type.
 */
typedef uint16_t Uint16;
#define SDL_MAX_UINT16  ((Uint16)0xFFFF)        /* 65535 */
#define SDL_MIN_UINT16  ((Uint16)0x0000)        /* 0 */

/**
 * A signed 32-bit integer type.
 */
typedef int32_t Sint32;
#define SDL_MAX_SINT32  ((Sint32)0x7FFFFFFF)    /* 2147483647 */
#define SDL_MIN_SINT32  ((Sint32)(~0x7FFFFFFF)) /* -2147483648 */

/**
 * An unsigned 32-bit integer type.
 */
typedef uint32_t Uint32;
#define SDL_MAX_UINT32  ((Uint32)0xFFFFFFFFu)   /* 4294967295 */
#define SDL_MIN_UINT32  ((Uint32)0x00000000)    /* 0 */

/**
 * A signed 64-bit integer type.
 */
typedef int64_t Sint64;
#define SDL_MAX_SINT64  ((Sint64)0x7FFFFFFFFFFFFFFFll)      /* 9223372036854775807 */
#define SDL_MIN_SINT64  ((Sint64)(~0x7FFFFFFFFFFFFFFFll))   /* -9223372036854775808 */

/**
 * An unsigned 64-bit integer type.
 */
typedef uint64_t Uint64;
#define SDL_MAX_UINT64  ((Uint64)0xFFFFFFFFFFFFFFFFull)     /* 18446744073709551615 */
#define SDL_MIN_UINT64  ((Uint64)(0x0000000000000000ull))   /* 0 */


/* @} *//* Basic data types */

/**
 *  \name Floating-point constants
 */
/* @{ */

#ifdef FLT_EPSILON
#define SDL_FLT_EPSILON FLT_EPSILON
#else
#define SDL_FLT_EPSILON 1.1920928955078125e-07F /* 0x0.000002p0 */
#endif

/* @} *//* Floating-point constants */

/* Make sure we have macros for printing width-based integers.
 * <stdint.h> should define these but this is not true all platforms.
 * (for example win32) */
#ifndef SDL_PRIs64
#if defined(__WIN32__) || defined(__GDK__)
#define SDL_PRIs64 "I64d"
#elif defined(PRId64)
#define SDL_PRIs64 PRId64
#elif defined(__LP64__) && !defined(__APPLE__) && !defined(__EMSCRIPTEN__)
#define SDL_PRIs64 "ld"
#else
#define SDL_PRIs64 "lld"
#endif
#endif
#ifndef SDL_PRIu64
#if defined(__WIN32__) || defined(__GDK__)
#define SDL_PRIu64 "I64u"
#elif defined(PRIu64)
#define SDL_PRIu64 PRIu64
#elif defined(__LP64__) && !defined(__APPLE__)
#define SDL_PRIu64 "lu"
#else
#define SDL_PRIu64 "llu"
#endif
#endif
#ifndef SDL_PRIx64
#if defined(__WIN32__) || defined(__GDK__)
#define SDL_PRIx64 "I64x"
#elif defined(PRIx64)
#define SDL_PRIx64 PRIx64
#elif defined(__LP64__) && !defined(__APPLE__)
#define SDL_PRIx64 "lx"
#else
#define SDL_PRIx64 "llx"
#endif
#endif
#ifndef SDL_PRIX64
#if defined(__WIN32__) || defined(__GDK__)
#define SDL_PRIX64 "I64X"
#elif defined(PRIX64)
#define SDL_PRIX64 PRIX64
#elif defined(__LP64__) && !defined(__APPLE__)
#define SDL_PRIX64 "lX"
#else
#define SDL_PRIX64 "llX"
#endif
#endif
#ifndef SDL_PRIs32
#ifdef PRId32
#define SDL_PRIs32 PRId32
#else
#define SDL_PRIs32 "d"
#endif
#endif
#ifndef SDL_PRIu32
#ifdef PRIu32
#define SDL_PRIu32 PRIu32
#else
#define SDL_PRIu32 "u"
#endif
#endif
#ifndef SDL_PRIx32
#ifdef PRIx32
#define SDL_PRIx32 PRIx32
#else
#define SDL_PRIx32 "x"
#endif
#endif
#ifndef SDL_PRIX32
#ifdef PRIX32
#define SDL_PRIX32 PRIX32
#else
#define SDL_PRIX32 "X"
#endif
#endif

/* Annotations to help code analysis tools */
#ifdef SDL_DISABLE_ANALYZE_MACROS
#define SDL_IN_BYTECAP(x)
#define SDL_INOUT_Z_CAP(x)
#define SDL_OUT_Z_CAP(x)
#define SDL_OUT_CAP(x)
#define SDL_OUT_BYTECAP(x)
#define SDL_OUT_Z_BYTECAP(x)
#define SDL_PRINTF_FORMAT_STRING
#define SDL_SCANF_FORMAT_STRING
#define SDL_PRINTF_VARARG_FUNC( fmtargnumber )
#define SDL_PRINTF_VARARG_FUNCV( fmtargnumber )
#define SDL_SCANF_VARARG_FUNC( fmtargnumber )
#define SDL_SCANF_VARARG_FUNCV( fmtargnumber )
#else
#if defined(_MSC_VER) && (_MSC_VER >= 1600) /* VS 2010 and above */
#include <sal.h>

#define SDL_IN_BYTECAP(x) _In_bytecount_(x)
#define SDL_INOUT_Z_CAP(x) _Inout_z_cap_(x)
#define SDL_OUT_Z_CAP(x) _Out_z_cap_(x)
#define SDL_OUT_CAP(x) _Out_cap_(x)
#define SDL_OUT_BYTECAP(x) _Out_bytecap_(x)
#define SDL_OUT_Z_BYTECAP(x) _Out_z_bytecap_(x)

#define SDL_PRINTF_FORMAT_STRING _Printf_format_string_
#define SDL_SCANF_FORMAT_STRING _Scanf_format_string_impl_
#else
#define SDL_IN_BYTECAP(x)
#define SDL_INOUT_Z_CAP(x)
#define SDL_OUT_Z_CAP(x)
#define SDL_OUT_CAP(x)
#define SDL_OUT_BYTECAP(x)
#define SDL_OUT_Z_BYTECAP(x)
#define SDL_PRINTF_FORMAT_STRING
#define SDL_SCANF_FORMAT_STRING
#endif
#if defined(__GNUC__)
#define SDL_PRINTF_VARARG_FUNC( fmtargnumber ) __attribute__ (( format( __printf__, fmtargnumber, fmtargnumber+1 )))
#define SDL_PRINTF_VARARG_FUNCV( fmtargnumber ) __attribute__(( format( __printf__, fmtargnumber, 0 )))
#define SDL_SCANF_VARARG_FUNC( fmtargnumber ) __attribute__ (( format( __scanf__, fmtargnumber, fmtargnumber+1 )))
#define SDL_SCANF_VARARG_FUNCV( fmtargnumber ) __attribute__(( format( __scanf__, fmtargnumber, 0 )))
#else
#define SDL_PRINTF_VARARG_FUNC( fmtargnumber )
#define SDL_PRINTF_VARARG_FUNCV( fmtargnumber )
#define SDL_SCANF_VARARG_FUNC( fmtargnumber )
#define SDL_SCANF_VARARG_FUNCV( fmtargnumber )
#endif
#endif /* SDL_DISABLE_ANALYZE_MACROS */

#ifndef SDL_COMPILE_TIME_ASSERT
#if defined(__cplusplus)
/* Keep C++ case alone: Some versions of gcc will define __STDC_VERSION__ even when compiling in C++ mode. */
#if (__cplusplus >= 201103L)
#define SDL_COMPILE_TIME_ASSERT(name, x)  static_assert(x, #x)
#endif
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 202311L)
#define SDL_COMPILE_TIME_ASSERT(name, x)  static_assert(x, #x)
#elif defined(__STDC_VERSION__) && (__STDC_VERSION__ >= 201112L)
#define SDL_COMPILE_TIME_ASSERT(name, x) _Static_assert(x, #x)
#endif
#endif /* !SDL_COMPILE_TIME_ASSERT */

#ifndef SDL_COMPILE_TIME_ASSERT
/* universal, but may trigger -Wunused-local-typedefs */
#define SDL_COMPILE_TIME_ASSERT(name, x)               \
       typedef int SDL_compile_time_assert_ ## name[(x) * 2 - 1]
#endif

/** \cond */
#ifndef DOXYGEN_SHOULD_IGNORE_THIS
SDL_COMPILE_TIME_ASSERT(uint8, sizeof(Uint8) == 1);
SDL_COMPILE_TIME_ASSERT(sint8, sizeof(Sint8) == 1);
SDL_COMPILE_TIME_ASSERT(uint16, sizeof(Uint16) == 2);
SDL_COMPILE_TIME_ASSERT(sint16, sizeof(Sint16) == 2);
SDL_COMPILE_TIME_ASSERT(uint32, sizeof(Uint32) == 4);
SDL_COMPILE_TIME_ASSERT(sint32, sizeof(Sint32) == 4);
SDL_COMPILE_TIME_ASSERT(uint64, sizeof(Uint64) == 8);
SDL_COMPILE_TIME_ASSERT(sint64, sizeof(Sint64) == 8);
#endif /* DOXYGEN_SHOULD_IGNORE_THIS */
/** \endcond */

/* Check to make sure enums are the size of ints, for structure packing.
   For both Watcom C/C++ and Borland C/C++ the compiler option that makes
   enums having the size of an int must be enabled.
   This is "-b" for Borland C/C++ and "-ei" for Watcom C/C++ (v11).
*/

/** \cond */
#ifndef DOXYGEN_SHOULD_IGNORE_THIS
#if !defined(__VITA__) && !defined(__3DS__)
/* TODO: include/SDL_stdinc.h:422: error: size of array 'SDL_dummy_enum' is negative */
typedef enum
{
    DUMMY_ENUM_VALUE
} SDL_DUMMY_ENUM;

SDL_COMPILE_TIME_ASSERT(enum, sizeof(SDL_DUMMY_ENUM) == sizeof(int));
#endif
#endif /* DOXYGEN_SHOULD_IGNORE_THIS */
/** \endcond */

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

#ifdef HAVE_ALLOCA
#define SDL_stack_alloc(type, count)    (type*)alloca(sizeof(type)*(count))
#define SDL_stack_free(data)
#else
#define SDL_stack_alloc(type, count)    (type*)SDL_malloc(sizeof(type)*(count))
#define SDL_stack_free(data)            SDL_free(data)
#endif

extern DECLSPEC void *SDLCALL SDL_malloc(size_t size);
extern DECLSPEC void *SDLCALL SDL_calloc(size_t nmemb, size_t size);
extern DECLSPEC void *SDLCALL SDL_realloc(void *mem, size_t size);
extern DECLSPEC void SDLCALL SDL_free(void *mem);

typedef void *(SDLCALL *SDL_malloc_func)(size_t size);
typedef void *(SDLCALL *SDL_calloc_func)(size_t nmemb, size_t size);
typedef void *(SDLCALL *SDL_realloc_func)(void *mem, size_t size);
typedef void (SDLCALL *SDL_free_func)(void *mem);

/**
 * Get the original set of SDL memory functions
 *
 * \since This function is available since SDL 2.24.0.
 */
extern DECLSPEC void SDLCALL SDL_GetOriginalMemoryFunctions(SDL_malloc_func *malloc_func,
                                                            SDL_calloc_func *calloc_func,
                                                            SDL_realloc_func *realloc_func,
                                                            SDL_free_func *free_func);

/**
 * Get the current set of SDL memory functions
 *
 * \since This function is available since SDL 2.0.7.
 */
extern DECLSPEC void SDLCALL SDL_GetMemoryFunctions(SDL_malloc_func *malloc_func,
                                                    SDL_calloc_func *calloc_func,
                                                    SDL_realloc_func *realloc_func,
                                                    SDL_free_func *free_func);

/**
 * Replace SDL's memory allocation functions with a custom set
 *
 * \since This function is available since SDL 2.0.7.
 */
extern DECLSPEC int SDLCALL SDL_SetMemoryFunctions(SDL_malloc_func malloc_func,
                                                   SDL_calloc_func calloc_func,
                                                   SDL_realloc_func realloc_func,
                                                   SDL_free_func free_func);

/**
 * Get the number of outstanding (unfreed) allocations
 *
 * \since This function is available since SDL 2.0.7.
 */
extern DECLSPEC int SDLCALL SDL_GetNumAllocations(void);

extern DECLSPEC char *SDLCALL SDL_getenv(const char *name);
extern DECLSPEC int SDLCALL SDL_setenv(const char *name, const char *value, int overwrite);

typedef int (SDLCALL *SDL_CompareCallback)(const void *, const void *);
extern DECLSPEC void SDLCALL SDL_qsort(void *base, size_t nmemb, size_t size, SDL_CompareCallback compare);
extern DECLSPEC void * SDLCALL SDL_bsearch(const void *key, const void *base, size_t nmemb, size_t size, SDL_CompareCallback compare);

extern DECLSPEC int SDLCALL SDL_abs(int x);

/* NOTE: these double-evaluate their arguments, so you should never have side effects in the parameters */
#define SDL_min(x, y) (((x) < (y)) ? (x) : (y))
#define SDL_max(x, y) (((x) > (y)) ? (x) : (y))
#define SDL_clamp(x, a, b) (((x) < (a)) ? (a) : (((x) > (b)) ? (b) : (x)))

extern DECLSPEC int SDLCALL SDL_isalpha(int x);
extern DECLSPEC int SDLCALL SDL_isalnum(int x);
extern DECLSPEC int SDLCALL SDL_isblank(int x);
extern DECLSPEC int SDLCALL SDL_iscntrl(int x);
extern DECLSPEC int SDLCALL SDL_isdigit(int x);
extern DECLSPEC int SDLCALL SDL_isxdigit(int x);
extern DECLSPEC int SDLCALL SDL_ispunct(int x);
extern DECLSPEC int SDLCALL SDL_isspace(int x);
extern DECLSPEC int SDLCALL SDL_isupper(int x);
extern DECLSPEC int SDLCALL SDL_islower(int x);
extern DECLSPEC int SDLCALL SDL_isprint(int x);
extern DECLSPEC int SDLCALL SDL_isgraph(int x);
extern DECLSPEC int SDLCALL SDL_toupper(int x);
extern DECLSPEC int SDLCALL SDL_tolower(int x);

extern DECLSPEC Uint16 SDLCALL SDL_crc16(Uint16 crc, const void *data, size_t len);
extern DECLSPEC Uint32 SDLCALL SDL_crc32(Uint32 crc, const void *data, size_t len);

extern DECLSPEC void *SDLCALL SDL_memset(SDL_OUT_BYTECAP(len) void *dst, int c, size_t len);

/* Some safe(r) macros for zero'ing structures... */
#define SDL_zero(x) SDL_memset(&(x), 0, sizeof((x)))
#define SDL_zerop(x) SDL_memset((x), 0, sizeof(*(x)))
#define SDL_zeroa(x) SDL_memset((x), 0, sizeof((x)))

#define SDL_copyp(dst, src)                                                                 \
    { SDL_COMPILE_TIME_ASSERT(SDL_copyp, sizeof (*(dst)) == sizeof (*(src))); }             \
    SDL_memcpy((dst), (src), sizeof (*(src)))


/* Note that memset() is a byte assignment and this is a 32-bit assignment, so they're not directly equivalent. */
SDL_FORCE_INLINE void SDL_memset4(void *dst, Uint32 val, size_t dwords)
{
#if defined(__GNUC__) && defined(__i386__)
    int u0, u1, u2;
    __asm__ __volatile__ (
        "cld \n\t"
        "rep ; stosl \n\t"
        : "=&D" (u0), "=&a" (u1), "=&c" (u2)
        : "0" (dst), "1" (val), "2" (SDL_static_cast(Uint32, dwords))
        : "memory"
    );
#else
    size_t _n = (dwords + 3) / 4;
    Uint32 *_p = SDL_static_cast(Uint32 *, dst);
    Uint32 _val = (val);
    if (dwords == 0) {
        return;
    }
    switch (dwords % 4) {
        case 0: do {    *_p++ = _val;   SDL_FALLTHROUGH;
        case 3:         *_p++ = _val;   SDL_FALLTHROUGH;
        case 2:         *_p++ = _val;   SDL_FALLTHROUGH;
        case 1:         *_p++ = _val;
        } while ( --_n );
    }
#endif
}

extern DECLSPEC void *SDLCALL SDL_memcpy(SDL_OUT_BYTECAP(len) void *dst, SDL_IN_BYTECAP(len) const void *src, size_t len);

extern DECLSPEC void *SDLCALL SDL_memmove(SDL_OUT_BYTECAP(len) void *dst, SDL_IN_BYTECAP(len) const void *src, size_t len);
extern DECLSPEC int SDLCALL SDL_memcmp(const void *s1, const void *s2, size_t len);

extern DECLSPEC size_t SDLCALL SDL_wcslen(const wchar_t *wstr);
extern DECLSPEC size_t SDLCALL SDL_wcslcpy(SDL_OUT_Z_CAP(maxlen) wchar_t *dst, const wchar_t *src, size_t maxlen);
extern DECLSPEC size_t SDLCALL SDL_wcslcat(SDL_INOUT_Z_CAP(maxlen) wchar_t *dst, const wchar_t *src, size_t maxlen);
extern DECLSPEC wchar_t *SDLCALL SDL_wcsdup(const wchar_t *wstr);
extern DECLSPEC wchar_t *SDLCALL SDL_wcsstr(const wchar_t *haystack, const wchar_t *needle);

extern DECLSPEC int SDLCALL SDL_wcscmp(const wchar_t *str1, const wchar_t *str2);
extern DECLSPEC int SDLCALL SDL_wcsncmp(const wchar_t *str1, const wchar_t *str2, size_t maxlen);
extern DECLSPEC int SDLCALL SDL_wcscasecmp(const wchar_t *str1, const wchar_t *str2);
extern DECLSPEC int SDLCALL SDL_wcsncasecmp(const wchar_t *str1, const wchar_t *str2, size_t len);

extern DECLSPEC size_t SDLCALL SDL_strlen(const char *str);
extern DECLSPEC size_t SDLCALL SDL_strlcpy(SDL_OUT_Z_CAP(maxlen) char *dst, const char *src, size_t maxlen);
extern DECLSPEC size_t SDLCALL SDL_utf8strlcpy(SDL_OUT_Z_CAP(dst_bytes) char *dst, const char *src, size_t dst_bytes);
extern DECLSPEC size_t SDLCALL SDL_strlcat(SDL_INOUT_Z_CAP(maxlen) char *dst, const char *src, size_t maxlen);
extern DECLSPEC char *SDLCALL SDL_strdup(const char *str);
extern DECLSPEC char *SDLCALL SDL_strrev(char *str);
extern DECLSPEC char *SDLCALL SDL_strupr(char *str);
extern DECLSPEC char *SDLCALL SDL_strlwr(char *str);
extern DECLSPEC char *SDLCALL SDL_strchr(const char *str, int c);
extern DECLSPEC char *SDLCALL SDL_strrchr(const char *str, int c);
extern DECLSPEC char *SDLCALL SDL_strstr(const char *haystack, const char *needle);
extern DECLSPEC char *SDLCALL SDL_strcasestr(const char *haystack, const char *needle);
extern DECLSPEC char *SDLCALL SDL_strtokr(char *s1, const char *s2, char **saveptr);
extern DECLSPEC size_t SDLCALL SDL_utf8strlen(const char *str);
extern DECLSPEC size_t SDLCALL SDL_utf8strnlen(const char *str, size_t bytes);

extern DECLSPEC char *SDLCALL SDL_itoa(int value, char *str, int radix);
extern DECLSPEC char *SDLCALL SDL_uitoa(unsigned int value, char *str, int radix);
extern DECLSPEC char *SDLCALL SDL_ltoa(long value, char *str, int radix);
extern DECLSPEC char *SDLCALL SDL_ultoa(unsigned long value, char *str, int radix);
extern DECLSPEC char *SDLCALL SDL_lltoa(Sint64 value, char *str, int radix);
extern DECLSPEC char *SDLCALL SDL_ulltoa(Uint64 value, char *str, int radix);

extern DECLSPEC int SDLCALL SDL_atoi(const char *str);
extern DECLSPEC double SDLCALL SDL_atof(const char *str);
extern DECLSPEC long SDLCALL SDL_strtol(const char *str, char **endp, int base);
extern DECLSPEC unsigned long SDLCALL SDL_strtoul(const char *str, char **endp, int base);
extern DECLSPEC Sint64 SDLCALL SDL_strtoll(const char *str, char **endp, int base);
extern DECLSPEC Uint64 SDLCALL SDL_strtoull(const char *str, char **endp, int base);
extern DECLSPEC double SDLCALL SDL_strtod(const char *str, char **endp);

extern DECLSPEC int SDLCALL SDL_strcmp(const char *str1, const char *str2);
extern DECLSPEC int SDLCALL SDL_strncmp(const char *str1, const char *str2, size_t maxlen);
extern DECLSPEC int SDLCALL SDL_strcasecmp(const char *str1, const char *str2);
extern DECLSPEC int SDLCALL SDL_strncasecmp(const char *str1, const char *str2, size_t len);

extern DECLSPEC int SDLCALL SDL_sscanf(const char *text, SDL_SCANF_FORMAT_STRING const char *fmt, ...) SDL_SCANF_VARARG_FUNC(2);
extern DECLSPEC int SDLCALL SDL_vsscanf(const char *text, SDL_SCANF_FORMAT_STRING const char *fmt, va_list ap) SDL_SCANF_VARARG_FUNCV(2);
extern DECLSPEC int SDLCALL SDL_snprintf(SDL_OUT_Z_CAP(maxlen) char *text, size_t maxlen, SDL_PRINTF_FORMAT_STRING const char *fmt, ... ) SDL_PRINTF_VARARG_FUNC(3);
extern DECLSPEC int SDLCALL SDL_vsnprintf(SDL_OUT_Z_CAP(maxlen) char *text, size_t maxlen, SDL_PRINTF_FORMAT_STRING const char *fmt, va_list ap) SDL_PRINTF_VARARG_FUNCV(3);
extern DECLSPEC int SDLCALL SDL_asprintf(char **strp, SDL_PRINTF_FORMAT_STRING const char *fmt, ...) SDL_PRINTF_VARARG_FUNC(2);
extern DECLSPEC int SDLCALL SDL_vasprintf(char **strp, SDL_PRINTF_FORMAT_STRING const char *fmt, va_list ap) SDL_PRINTF_VARARG_FUNCV(2);

#ifndef HAVE_M_PI
#ifndef M_PI
#define M_PI    3.14159265358979323846264338327950288   /**< pi */
#endif
#endif

/**
 * Use this function to compute arc cosine of `x`.
 *
 * The definition of `y = acos(x)` is `x = cos(y)`.
 *
 * Domain: `-1 <= x <= 1`
 *
 * Range: `0 <= y <= Pi`
 *
 * \param x floating point value, in radians.
 * \returns arc cosine of `x`.
 *
 * \since This function is available since SDL 2.0.2.
 */
extern DECLSPEC double SDLCALL SDL_acos(double x);
extern DECLSPEC float SDLCALL SDL_acosf(float x);
extern DECLSPEC double SDLCALL SDL_asin(double x);
extern DECLSPEC float SDLCALL SDL_asinf(float x);
extern DECLSPEC double SDLCALL SDL_atan(double x);
extern DECLSPEC float SDLCALL SDL_atanf(float x);
extern DECLSPEC double SDLCALL SDL_atan2(double y, double x);
extern DECLSPEC float SDLCALL SDL_atan2f(float y, float x);
extern DECLSPEC double SDLCALL SDL_ceil(double x);
extern DECLSPEC float SDLCALL SDL_ceilf(float x);
extern DECLSPEC double SDLCALL SDL_copysign(double x, double y);
extern DECLSPEC float SDLCALL SDL_copysignf(float x, float y);
extern DECLSPEC double SDLCALL SDL_cos(double x);
extern DECLSPEC float SDLCALL SDL_cosf(float x);
extern DECLSPEC double SDLCALL SDL_exp(double x);
extern DECLSPEC float SDLCALL SDL_expf(float x);
extern DECLSPEC double SDLCALL SDL_fabs(double x);
extern DECLSPEC float SDLCALL SDL_fabsf(float x);
extern DECLSPEC double SDLCALL SDL_floor(double x);
extern DECLSPEC float SDLCALL SDL_floorf(float x);
extern DECLSPEC double SDLCALL SDL_trunc(double x);
extern DECLSPEC float SDLCALL SDL_truncf(float x);
extern DECLSPEC double SDLCALL SDL_fmod(double x, double y);
extern DECLSPEC float SDLCALL SDL_fmodf(float x, float y);
extern DECLSPEC double SDLCALL SDL_log(double x);
extern DECLSPEC float SDLCALL SDL_logf(float x);
extern DECLSPEC double SDLCALL SDL_log10(double x);
extern DECLSPEC float SDLCALL SDL_log10f(float x);
extern DECLSPEC double SDLCALL SDL_pow(double x, double y);
extern DECLSPEC float SDLCALL SDL_powf(float x, float y);
extern DECLSPEC double SDLCALL SDL_round(double x);
extern DECLSPEC float SDLCALL SDL_roundf(float x);
extern DECLSPEC long SDLCALL SDL_lround(double x);
extern DECLSPEC long SDLCALL SDL_lroundf(float x);
extern DECLSPEC double SDLCALL SDL_scalbn(double x, int n);
extern DECLSPEC float SDLCALL SDL_scalbnf(float x, int n);
extern DECLSPEC double SDLCALL SDL_sin(double x);
extern DECLSPEC float SDLCALL SDL_sinf(float x);
extern DECLSPEC double SDLCALL SDL_sqrt(double x);
extern DECLSPEC float SDLCALL SDL_sqrtf(float x);
extern DECLSPEC double SDLCALL SDL_tan(double x);
extern DECLSPEC float SDLCALL SDL_tanf(float x);

/* The SDL implementation of iconv() returns these error codes */
#define SDL_ICONV_ERROR     (size_t)-1
#define SDL_ICONV_E2BIG     (size_t)-2
#define SDL_ICONV_EILSEQ    (size_t)-3
#define SDL_ICONV_EINVAL    (size_t)-4

/* SDL_iconv_* are now always real symbols/types, not macros or inlined. */
typedef struct _SDL_iconv_t *SDL_iconv_t;
extern DECLSPEC SDL_iconv_t SDLCALL SDL_iconv_open(const char *tocode,
                                                   const char *fromcode);
extern DECLSPEC int SDLCALL SDL_iconv_close(SDL_iconv_t cd);
extern DECLSPEC size_t SDLCALL SDL_iconv(SDL_iconv_t cd, const char **inbuf,
                                         size_t * inbytesleft, char **outbuf,
                                         size_t * outbytesleft);

/**
 * This function converts a buffer or string between encodings in one pass,
 * returning a string that must be freed with SDL_free() or NULL on error.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC char *SDLCALL SDL_iconv_string(const char *tocode,
                                               const char *fromcode,
                                               const char *inbuf,
                                               size_t inbytesleft);

/* Some helper macros for common cases... */
#define SDL_iconv_utf8_locale(S)    SDL_iconv_string("", "UTF-8", S, SDL_strlen(S)+1)
#define SDL_iconv_utf8_ucs2(S)      (Uint16 *)SDL_iconv_string("UCS-2", "UTF-8", S, SDL_strlen(S)+1)
#define SDL_iconv_utf8_ucs4(S)      (Uint32 *)SDL_iconv_string("UCS-4", "UTF-8", S, SDL_strlen(S)+1)
#define SDL_iconv_wchar_utf8(S)     SDL_iconv_string("UTF-8", "WCHAR_T", (char *)S, (SDL_wcslen(S)+1)*sizeof(wchar_t))

/* force builds using Clang's static analysis tools to use literal C runtime
   here, since there are possibly tests that are ineffective otherwise. */
#if defined(__clang_analyzer__) && !defined(SDL_DISABLE_ANALYZE_MACROS)

/* The analyzer knows about strlcpy even when the system doesn't provide it */
#ifndef HAVE_STRLCPY
size_t strlcpy(char* dst, const char* src, size_t size);
#endif

/* The analyzer knows about strlcat even when the system doesn't provide it */
#ifndef HAVE_STRLCAT
size_t strlcat(char* dst, const char* src, size_t size);
#endif

#ifndef HAVE_WCSLCPY
size_t wcslcpy(wchar_t *dst, const wchar_t *src, size_t size);
#endif

#ifndef HAVE_WCSLCAT
size_t wcslcat(wchar_t *dst, const wchar_t *src, size_t size);
#endif

#ifndef _WIN32
/* strdup is not ANSI but POSIX, and its prototype might be hidden... */
/* not for windows: might conflict with string.h where strdup may have
 * dllimport attribute: https://github.com/libsdl-org/SDL/issues/12948 */
char *strdup(const char *str);
#endif

/* Starting LLVM 16, the analyser errors out if these functions do not have
   their prototype defined (clang-diagnostic-implicit-function-declaration) */
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define SDL_malloc malloc
#define SDL_calloc calloc
#define SDL_realloc realloc
#define SDL_free free
#define SDL_memset memset
#define SDL_memcpy memcpy
#define SDL_memmove memmove
#define SDL_memcmp memcmp
#define SDL_strlcpy strlcpy
#define SDL_strlcat strlcat
#define SDL_strlen strlen
#define SDL_wcslen wcslen
#define SDL_wcslcpy wcslcpy
#define SDL_wcslcat wcslcat
#define SDL_strdup strdup
#define SDL_wcsdup wcsdup
#define SDL_strchr strchr
#define SDL_strrchr strrchr
#define SDL_strstr strstr
#define SDL_wcsstr wcsstr
#define SDL_strtokr strtok_r
#define SDL_strcmp strcmp
#define SDL_wcscmp wcscmp
#define SDL_strncmp strncmp
#define SDL_wcsncmp wcsncmp
#define SDL_strcasecmp strcasecmp
#define SDL_strncasecmp strncasecmp
#define SDL_sscanf sscanf
#define SDL_vsscanf vsscanf
#define SDL_snprintf snprintf
#define SDL_vsnprintf vsnprintf
#endif

SDL_FORCE_INLINE void *SDL_memcpy4(SDL_OUT_BYTECAP(dwords*4) void *dst, SDL_IN_BYTECAP(dwords*4) const void *src, size_t dwords)
{
    return SDL_memcpy(dst, src, dwords * 4);
}

/**
 * If a * b would overflow, return -1.
 *
 * Otherwise store a * b via ret and return 0.
 *
 * \since This function is available since SDL 2.24.0.
 */
SDL_FORCE_INLINE int SDL_size_mul_overflow (size_t a,
                                            size_t b,
                                            size_t *ret)
{
    if (a != 0 && b > SDL_SIZE_MAX / a) {
        return -1;
    }
    *ret = a * b;
    return 0;
}

#if _SDL_HAS_BUILTIN(__builtin_mul_overflow)
/* This needs to be wrapped in an inline rather than being a direct #define,
 * because __builtin_mul_overflow() is type-generic, but we want to be
 * consistent about interpreting a and b as size_t. */
SDL_FORCE_INLINE int _SDL_size_mul_overflow_builtin (size_t a,
                                                     size_t b,
                                                     size_t *ret)
{
    return __builtin_mul_overflow(a, b, ret) == 0 ? 0 : -1;
}
#define SDL_size_mul_overflow(a, b, ret) (_SDL_size_mul_overflow_builtin(a, b, ret))
#endif

/**
 * If a + b would overflow, return -1.
 *
 * Otherwise store a + b via ret and return 0.
 *
 * \since This function is available since SDL 2.24.0.
 */
SDL_FORCE_INLINE int SDL_size_add_overflow (size_t a,
                                            size_t b,
                                            size_t *ret)
{
    if (b > SDL_SIZE_MAX - a) {
        return -1;
    }
    *ret = a + b;
    return 0;
}

#if _SDL_HAS_BUILTIN(__builtin_add_overflow)
/* This needs to be wrapped in an inline rather than being a direct #define,
 * the same as the call to __builtin_mul_overflow() above. */
SDL_FORCE_INLINE int _SDL_size_add_overflow_builtin (size_t a,
                                                     size_t b,
                                                     size_t *ret)
{
    return __builtin_add_overflow(a, b, ret) == 0 ? 0 : -1;
}
#define SDL_size_add_overflow(a, b, ret) (_SDL_size_add_overflow_builtin(a, b, ret))
#endif

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_stdinc_h_ */

/* vi: set ts=4 sw=4 expandtab: */
