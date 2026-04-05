// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2015-2016, International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef ULISTFORMATTER_H
#define ULISTFORMATTER_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/uformattedvalue.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Format a list in a locale-appropriate way.
 *
 * A UListFormatter is used to format a list of items in a locale-appropriate way, 
 * using data from CLDR.
 * Example: Input data ["Alice", "Bob", "Charlie", "Delta"] will be formatted
 * as "Alice, Bob, Charlie, and Delta" in English.
 */

/**
 * Opaque UListFormatter object for use in C
 * @stable ICU 55
 */
struct UListFormatter;
typedef struct UListFormatter UListFormatter;  /**< C typedef for struct UListFormatter. @stable ICU 55 */

struct UFormattedList;
/**
 * Opaque struct to contain the results of a UListFormatter operation.
 * @stable ICU 64
 */
typedef struct UFormattedList UFormattedList;

/**
 * FieldPosition and UFieldPosition selectors for format fields
 * defined by ListFormatter.
 * @stable ICU 63
 */
typedef enum UListFormatterField {
    /**
     * The literal text in the result which came from the resources.
     * @stable ICU 63
     */
    ULISTFMT_LITERAL_FIELD,
    /**
     * The element text in the result which came from the input strings.
     * @stable ICU 63
     */
    ULISTFMT_ELEMENT_FIELD
} UListFormatterField;

/**
 * Type of meaning expressed by the list.
 *
 * @stable ICU 67
 */
typedef enum UListFormatterType {
    /**
     * Conjunction formatting, e.g. "Alice, Bob, Charlie, and Delta".
     *
     * @stable ICU 67
     */
    ULISTFMT_TYPE_AND,

    /**
     * Disjunction (or alternative, or simply one of) formatting, e.g.
     * "Alice, Bob, Charlie, or Delta".
     *
     * @stable ICU 67
     */
    ULISTFMT_TYPE_OR,

    /**
     * Formatting of a list of values with units, e.g. "5 pounds, 12 ounces".
     *
     * @stable ICU 67
     */
    ULISTFMT_TYPE_UNITS
} UListFormatterType;

/**
 * Verbosity level of the list patterns.
 *
 * @stable ICU 67
 */
typedef enum UListFormatterWidth {
    /**
     * Use list formatting with full words (no abbreviations) when possible.
     *
     * @stable ICU 67
     */
    ULISTFMT_WIDTH_WIDE,

    /**
     * Use list formatting of typical length.
     * @stable ICU 67
     */
    ULISTFMT_WIDTH_SHORT,

    /**
     * Use list formatting of the shortest possible length.
     * @stable ICU 67
     */
    ULISTFMT_WIDTH_NARROW,
} UListFormatterWidth;

/**
 * Open a new UListFormatter object using the rules for a given locale.
 * The object will be initialized with AND type and WIDE width.
 *
 * @param locale
 *            The locale whose rules should be used; may be NULL for
 *            default locale.
 * @param status
 *            A pointer to a standard ICU UErrorCode (input/output parameter).
 *            Its input value must pass the U_SUCCESS() test, or else the
 *            function returns immediately. The caller should check its output
 *            value with U_FAILURE(), or use with function chaining (see User
 *            Guide for details).
 * @return
 *            A pointer to a UListFormatter object for the specified locale,
 *            or NULL if an error occurred.
 * @stable ICU 55
 */
U_CAPI UListFormatter* U_EXPORT2
ulistfmt_open(const char*  locale,
              UErrorCode*  status);

/**
 * Open a new UListFormatter object appropriate for the given locale, list type,
 * and style.
 *
 * @param locale
 *            The locale whose rules should be used; may be NULL for
 *            default locale.
 * @param type
 *            The type of list formatting to use.
 * @param width
 *            The width of formatting to use.
 * @param status
 *            A pointer to a standard ICU UErrorCode (input/output parameter).
 *            Its input value must pass the U_SUCCESS() test, or else the
 *            function returns immediately. The caller should check its output
 *            value with U_FAILURE(), or use with function chaining (see User
 *            Guide for details).
 * @return
 *            A pointer to a UListFormatter object for the specified locale,
 *            or NULL if an error occurred.
 * @stable ICU 67
 */
U_CAPI UListFormatter* U_EXPORT2
ulistfmt_openForType(const char*  locale, UListFormatterType type,
                     UListFormatterWidth width, UErrorCode*  status);

/**
 * Close a UListFormatter object. Once closed it may no longer be used.
 * @param listfmt
 *            The UListFormatter object to close.
 * @stable ICU 55
 */
U_CAPI void U_EXPORT2
ulistfmt_close(UListFormatter *listfmt);

/**
 * Creates an object to hold the result of a UListFormatter
 * operation. The object can be used repeatedly; it is cleared whenever
 * passed to a format function.
 *
 * @param ec Set if an error occurs.
 * @return A pointer needing ownership.
 * @stable ICU 64
 */
U_CAPI UFormattedList* U_EXPORT2
ulistfmt_openResult(UErrorCode* ec);

/**
 * Returns a representation of a UFormattedList as a UFormattedValue,
 * which can be subsequently passed to any API requiring that type.
 *
 * The returned object is owned by the UFormattedList and is valid
 * only as long as the UFormattedList is present and unchanged in memory.
 *
 * You can think of this method as a cast between types.
 *
 * When calling ufmtval_nextPosition():
 * The fields are returned from start to end. The special field category
 * UFIELD_CATEGORY_LIST_SPAN is used to indicate which argument
 * was inserted at the given position. The span category will
 * always occur before the corresponding instance of UFIELD_CATEGORY_LIST
 * in the ufmtval_nextPosition() iterator.
 *
 * @param uresult The object containing the formatted string.
 * @param ec Set if an error occurs.
 * @return A UFormattedValue owned by the input object.
 * @stable ICU 64
 */
U_CAPI const UFormattedValue* U_EXPORT2
ulistfmt_resultAsValue(const UFormattedList* uresult, UErrorCode* ec);

/**
 * Releases the UFormattedList created by ulistfmt_openResult().
 *
 * @param uresult The object to release.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ulistfmt_closeResult(UFormattedList* uresult);


#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUListFormatterPointer
 * "Smart pointer" class, closes a UListFormatter via ulistfmt_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 55
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUListFormatterPointer, UListFormatter, ulistfmt_close);

/**
 * \class LocalUFormattedListPointer
 * "Smart pointer" class, closes a UFormattedList via ulistfmt_closeResult().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 64
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattedListPointer, UFormattedList, ulistfmt_closeResult);

U_NAMESPACE_END

#endif

/**
 * Formats a list of strings using the conventions established for the
 * UListFormatter object.
 * @param listfmt
 *            The UListFormatter object specifying the list conventions.
 * @param strings
 *            An array of pointers to UChar strings; the array length is
 *            specified by stringCount. Must be non-NULL if stringCount > 0.
 * @param stringLengths
 *            An array of string lengths corresponding to the strings[]
 *            parameter; any individual length value may be negative to indicate
 *            that the corresponding strings[] entry is 0-terminated, or
 *            stringLengths itself may be NULL if all of the strings are
 *            0-terminated. If non-NULL, the stringLengths array must have
 *            stringCount entries.
 * @param stringCount
 *            the number of entries in strings[], and the number of entries
 *            in the stringLengths array if it is not NULL. Must be >= 0.
 * @param result
 *            A pointer to a buffer to receive the formatted list.
 * @param resultCapacity
 *            The maximum size of result.
 * @param status
 *            A pointer to a standard ICU UErrorCode (input/output parameter).
 *            Its input value must pass the U_SUCCESS() test, or else the
 *            function returns immediately. The caller should check its output
 *            value with U_FAILURE(), or use with function chaining (see User
 *            Guide for details).
 * @return
 *            The total buffer size needed; if greater than resultLength, the
 *            output was truncated. May be <=0 if unable to determine the
 *            total buffer size needed (e.g. for illegal arguments).
 * @stable ICU 55
 */
U_CAPI int32_t U_EXPORT2
ulistfmt_format(const UListFormatter* listfmt,
                const UChar* const strings[],
                const int32_t *    stringLengths,
                int32_t            stringCount,
                UChar*             result,
                int32_t            resultCapacity,
                UErrorCode*        status);

/**
 * Formats a list of strings to a UFormattedList, which exposes more
 * information than the string exported by ulistfmt_format().
 *
 * @param listfmt
 *            The UListFormatter object specifying the list conventions.
 * @param strings
 *            An array of pointers to UChar strings; the array length is
 *            specified by stringCount. Must be non-NULL if stringCount > 0.
 * @param stringLengths
 *            An array of string lengths corresponding to the strings[]
 *            parameter; any individual length value may be negative to indicate
 *            that the corresponding strings[] entry is 0-terminated, or
 *            stringLengths itself may be NULL if all of the strings are
 *            0-terminated. If non-NULL, the stringLengths array must have
 *            stringCount entries.
 * @param stringCount
 *            the number of entries in strings[], and the number of entries
 *            in the stringLengths array if it is not NULL. Must be >= 0.
 * @param uresult
 *            The object in which to store the result of the list formatting
 *            operation. See ulistfmt_openResult().
 * @param status
 *            Error code set if an error occurred during formatting.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
ulistfmt_formatStringsToResult(
                const UListFormatter* listfmt,
                const UChar* const strings[],
                const int32_t *    stringLengths,
                int32_t            stringCount,
                UFormattedList*    uresult,
                UErrorCode*        status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
