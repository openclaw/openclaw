// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __UFORMATTEDNUMBER_H__
#define __UFORMATTEDNUMBER_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/ufieldpositer.h"
#include "unicode/uformattedvalue.h"
#include "unicode/umisc.h"

/**
 * \file
 * \brief C API: Formatted number result from various number formatting functions.
 *
 * Create a `UFormattedNumber` to hold the result of a number formatting operation. The same
 * `UFormattedNumber` can be reused multiple times.
 *
 * <pre>
 * LocalUFormattedNumberPointer uresult(unumf_openResult(status));
 *
 * // pass uresult.getAlias() to your number formatter
 *
 * int32_t length;
 * const UChar* s = ufmtval_getString(unumf_resultAsValue(uresult.getAlias(), status), &length, status));
 *
 * // The string result is in `s` with the given `length` (it is also NUL-terminated).
 * </pre>
 */


struct UFormattedNumber;
/**
 * C-compatible version of icu::number::FormattedNumber.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberformatter.h instead.
 *
 * @stable ICU 62
 */
typedef struct UFormattedNumber UFormattedNumber;


/**
 * Creates an object to hold the result of a UNumberFormatter
 * operation. The object can be used repeatedly; it is cleared whenever
 * passed to a format function.
 *
 * @param ec Set if an error occurs.
 * @stable ICU 62
 */
U_CAPI UFormattedNumber* U_EXPORT2
unumf_openResult(UErrorCode* ec);


/**
 * Returns a representation of a UFormattedNumber as a UFormattedValue,
 * which can be subsequently passed to any API requiring that type.
 *
 * The returned object is owned by the UFormattedNumber and is valid
 * only as long as the UFormattedNumber is present and unchanged in memory.
 *
 * You can think of this method as a cast between types.
 *
 * @param uresult The object containing the formatted string.
 * @param ec Set if an error occurs.
 * @return A UFormattedValue owned by the input object.
 * @stable ICU 64
 */
U_CAPI const UFormattedValue* U_EXPORT2
unumf_resultAsValue(const UFormattedNumber* uresult, UErrorCode* ec);


/**
 * Extracts the result number string out of a UFormattedNumber to a UChar buffer if possible.
 * If bufferCapacity is greater than the required length, a terminating NUL is written.
 * If bufferCapacity is less than the required length, an error code is set.
 *
 * Also see ufmtval_getString, which returns a NUL-terminated string:
 *
 *     int32_t len;
 *     const UChar* str = ufmtval_getString(unumf_resultAsValue(uresult, &ec), &len, &ec);
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberformatter.h instead.
 *
 * @param uresult The object containing the formatted number.
 * @param buffer Where to save the string output.
 * @param bufferCapacity The number of UChars available in the buffer.
 * @param ec Set if an error occurs.
 * @return The required length.
 * @stable ICU 62
 */
U_CAPI int32_t U_EXPORT2
unumf_resultToString(const UFormattedNumber* uresult, UChar* buffer, int32_t bufferCapacity,
                     UErrorCode* ec);


/**
 * Determines the start and end indices of the next occurrence of the given <em>field</em> in the
 * output string. This allows you to determine the locations of, for example, the integer part,
 * fraction part, or symbols.
 *
 * This is a simpler but less powerful alternative to {@link ufmtval_nextPosition}.
 *
 * If a field occurs just once, calling this method will find that occurrence and return it. If a
 * field occurs multiple times, this method may be called repeatedly with the following pattern:
 *
 * <pre>
 * UFieldPosition ufpos = {UNUM_GROUPING_SEPARATOR_FIELD, 0, 0};
 * while (unumf_resultNextFieldPosition(uresult, ufpos, &ec)) {
 *   // do something with ufpos.
 * }
 * </pre>
 *
 * This method is useful if you know which field to query. If you want all available field position
 * information, use unumf_resultGetAllFieldPositions().
 *
 * NOTE: All fields of the UFieldPosition must be initialized before calling this method.
 *
 * @param uresult The object containing the formatted number.
 * @param ufpos
 *            Input+output variable. On input, the "field" property determines which field to look up,
 *            and the "endIndex" property determines where to begin the search. On output, the
 *            "beginIndex" field is set to the beginning of the first occurrence of the field after the
 *            input "endIndex", and "endIndex" is set to the end of that occurrence of the field
 *            (exclusive index). If a field position is not found, the FieldPosition is not changed and
 *            the method returns false.
 * @param ec Set if an error occurs.
 * @stable ICU 62
 */
U_CAPI UBool U_EXPORT2
unumf_resultNextFieldPosition(const UFormattedNumber* uresult, UFieldPosition* ufpos, UErrorCode* ec);


/**
 * Populates the given iterator with all fields in the formatted output string. This allows you to
 * determine the locations of the integer part, fraction part, and sign.
 *
 * This is an alternative to the more powerful {@link ufmtval_nextPosition} API.
 *
 * If you need information on only one field, use {@link ufmtval_nextPosition} or
 * {@link unumf_resultNextFieldPosition}.
 *
 * @param uresult The object containing the formatted number.
 * @param ufpositer
 *         A pointer to a UFieldPositionIterator created by {@link #ufieldpositer_open}. Iteration
 *         information already present in the UFieldPositionIterator is deleted, and the iterator is reset
 *         to apply to the fields in the formatted string created by this function call. The field values
 *         and indexes returned by {@link #ufieldpositer_next} represent fields denoted by
 *         the UNumberFormatFields enum. Fields are not returned in a guaranteed order. Fields cannot
 *         overlap, but they may nest. For example, 1234 could format as "1,234" which might consist of a
 *         grouping separator field for ',' and an integer field encompassing the entire string.
 * @param ec Set if an error occurs.
 * @stable ICU 62
 */
U_CAPI void U_EXPORT2
unumf_resultGetAllFieldPositions(const UFormattedNumber* uresult, UFieldPositionIterator* ufpositer,
                                 UErrorCode* ec);


/**
 * Extracts the formatted number as a "numeric string" conforming to the
 * syntax defined in the Decimal Arithmetic Specification, available at
 * http://speleotrove.com/decimal
 *
 * This endpoint is useful for obtaining the exact number being printed
 * after scaling and rounding have been applied by the number formatter.
 *
 * @param uresult        The input object containing the formatted number.
 * @param  dest          the 8-bit char buffer into which the decimal number is placed
 * @param  destCapacity  The size, in chars, of the destination buffer.  May be zero
 *                       for precomputing the required size.
 * @param  ec            receives any error status.
 *                       If U_BUFFER_OVERFLOW_ERROR: Returns number of chars for
 *                       preflighting.
 * @return Number of chars in the data.  Does not include a trailing NUL.
 * @stable ICU 68
 */
U_CAPI int32_t U_EXPORT2
unumf_resultToDecimalNumber(
       const UFormattedNumber* uresult,
       char* dest,
       int32_t destCapacity,
       UErrorCode* ec);


/**
 * Releases the UFormattedNumber created by unumf_openResult().
 *
 * @param uresult An object created by unumf_openResult().
 * @stable ICU 62
 */
U_CAPI void U_EXPORT2
unumf_closeResult(UFormattedNumber* uresult);


#if U_SHOW_CPLUSPLUS_API
U_NAMESPACE_BEGIN

/**
 * \class LocalUFormattedNumberPointer
 * "Smart pointer" class; closes a UFormattedNumber via unumf_closeResult().
 * For most methods see the LocalPointerBase base class.
 *
 * Usage:
 * <pre>
 * LocalUFormattedNumberPointer uformatter(unumf_openResult(...));
 * // no need to explicitly call unumf_closeResult()
 * </pre>
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 62
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattedNumberPointer, UFormattedNumber, unumf_closeResult);

U_NAMESPACE_END
#endif // U_SHOW_CPLUSPLUS_API


#endif /* #if !UCONFIG_NO_FORMATTING */
#endif //__UFORMATTEDNUMBER_H__
