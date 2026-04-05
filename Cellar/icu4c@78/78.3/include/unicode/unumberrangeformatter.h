// © 2020 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __UNUMBERRANGEFORMATTER_H__
#define __UNUMBERRANGEFORMATTER_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/parseerr.h"
#include "unicode/ufieldpositer.h"
#include "unicode/umisc.h"
#include "unicode/uformattedvalue.h"
#include "unicode/uformattable.h"


/**
 * \file
 * \brief C API: Localized number range formatting
 *
 * This is the C-compatible version of the NumberRangeFormatter API. C++ users
 * should include unicode/numberrangeformatter.h and use the proper C++ APIs.
 *
 * First create a UNumberRangeFormatter, which is immutable, and then format to
 * a UFormattedNumberRange.
 *
 * Example code:
 * <pre>
 * // Setup:
 * UErrorCode ec = U_ZERO_ERROR;
 * UNumberRangeFormatter* uformatter = unumrf_openForSkeletonCollapseIdentityFallbackAndLocaleWithError(
 *     u"currency/USD precision-integer",
 *     -1,
 *     UNUM_RANGE_COLLAPSE_AUTO,
 *     UNUM_IDENTITY_FALLBACK_APPROXIMATELY,
 *     "en-US",
 *     NULL,
 *     &ec);
 * UFormattedNumberRange* uresult = unumrf_openResult(&ec);
 * if (U_FAILURE(ec)) { return; }
 *
 * // Format a double range:
 * unumrf_formatDoubleRange(uformatter, 3.0, 5.0, uresult, &ec);
 * if (U_FAILURE(ec)) { return; }
 *
 * // Get the result string:
 * int32_t len;
 * const UChar* str = ufmtval_getString(unumrf_resultAsValue(uresult, &ec), &len, &ec);
 * if (U_FAILURE(ec)) { return; }
 * // str should equal "$3 – $5"
 *
 * // Cleanup:
 * unumf_close(uformatter);
 * unumf_closeResult(uresult);
 * </pre>
 *
 * If you are a C++ user linking against the C libraries, you can use the LocalPointer versions of these
 * APIs. The following example uses LocalPointer with the decimal number and field position APIs:
 *
 * <pre>
 * // Setup:
 * LocalUNumberRangeFormatterPointer uformatter(
 *     unumrf_openForSkeletonCollapseIdentityFallbackAndLocaleWithError(...));
 * LocalUFormattedNumberRangePointer uresult(unumrf_openResult(&ec));
 * if (U_FAILURE(ec)) { return; }
 *
 * // Format a double number range:
 * unumrf_formatDoubleRange(uformatter.getAlias(), 3.0, 5.0, uresult.getAlias(), &ec);
 * if (U_FAILURE(ec)) { return; }
 *
 * // No need to do any cleanup since we are using LocalPointer.
 * </pre>
 *
 * You can also get field positions. For more information, see uformattedvalue.h.
 */

/**
 * Defines how to merge fields that are identical across the range sign.
 *
 * @stable ICU 63
 */
typedef enum UNumberRangeCollapse {
    /**
     * Use locale data and heuristics to determine how much of the string to collapse. Could end up collapsing none,
     * some, or all repeated pieces in a locale-sensitive way.
     *
     * The heuristics used for this option are subject to change over time.
     *
     * @stable ICU 63
     */
    UNUM_RANGE_COLLAPSE_AUTO,

    /**
     * Do not collapse any part of the number. Example: "3.2 thousand kilograms – 5.3 thousand kilograms"
     *
     * @stable ICU 63
     */
    UNUM_RANGE_COLLAPSE_NONE,

    /**
     * Collapse the unit part of the number, but not the notation, if present. Example: "3.2 thousand – 5.3 thousand
     * kilograms"
     *
     * @stable ICU 63
     */
    UNUM_RANGE_COLLAPSE_UNIT,

    /**
     * Collapse any field that is equal across the range sign. May introduce ambiguity on the magnitude of the
     * number. Example: "3.2 – 5.3 thousand kilograms"
     *
     * @stable ICU 63
     */
    UNUM_RANGE_COLLAPSE_ALL
} UNumberRangeCollapse;

/**
 * Defines the behavior when the two numbers in the range are identical after rounding. To programmatically detect
 * when the identity fallback is used, compare the lower and upper BigDecimals via FormattedNumber.
 *
 * @stable ICU 63
 * @see NumberRangeFormatter
 */
typedef enum UNumberRangeIdentityFallback {
    /**
     * Show the number as a single value rather than a range. Example: "$5"
     *
     * @stable ICU 63
     */
    UNUM_IDENTITY_FALLBACK_SINGLE_VALUE,

    /**
     * Show the number using a locale-sensitive approximation pattern. If the numbers were the same before rounding,
     * show the single value. Example: "~$5" or "$5"
     *
     * @stable ICU 63
     */
    UNUM_IDENTITY_FALLBACK_APPROXIMATELY_OR_SINGLE_VALUE,

    /**
     * Show the number using a locale-sensitive approximation pattern. Use the range pattern always, even if the
     * inputs are the same. Example: "~$5"
     *
     * @stable ICU 63
     */
    UNUM_IDENTITY_FALLBACK_APPROXIMATELY,

    /**
     * Show the number as the range of two equal values. Use the range pattern always, even if the inputs are the
     * same. Example (with RangeCollapse.NONE): "$5 – $5"
     *
     * @stable ICU 63
     */
    UNUM_IDENTITY_FALLBACK_RANGE
} UNumberRangeIdentityFallback;

/**
 * Used in the result class FormattedNumberRange to indicate to the user whether the numbers formatted in the range
 * were equal or not, and whether or not the identity fallback was applied.
 *
 * @stable ICU 63
 * @see NumberRangeFormatter
 */
typedef enum UNumberRangeIdentityResult {
    /**
     * Used to indicate that the two numbers in the range were equal, even before any rounding rules were applied.
     *
     * @stable ICU 63
     * @see NumberRangeFormatter
     */
    UNUM_IDENTITY_RESULT_EQUAL_BEFORE_ROUNDING,

    /**
     * Used to indicate that the two numbers in the range were equal, but only after rounding rules were applied.
     *
     * @stable ICU 63
     * @see NumberRangeFormatter
     */
    UNUM_IDENTITY_RESULT_EQUAL_AFTER_ROUNDING,

    /**
     * Used to indicate that the two numbers in the range were not equal, even after rounding rules were applied.
     *
     * @stable ICU 63
     * @see NumberRangeFormatter
     */
    UNUM_IDENTITY_RESULT_NOT_EQUAL,

#ifndef U_HIDE_INTERNAL_API
    /**
     * The number of entries in this enum.
     * @internal
     */
    UNUM_IDENTITY_RESULT_COUNT
#endif  /* U_HIDE_INTERNAL_API */

} UNumberRangeIdentityResult;


struct UNumberRangeFormatter;
/**
 * C-compatible version of icu::number::LocalizedNumberRangeFormatter.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberrangeformatter.h instead.
 *
 * @stable ICU 68
 */
typedef struct UNumberRangeFormatter UNumberRangeFormatter;


struct UFormattedNumberRange;
/**
 * C-compatible version of icu::number::FormattedNumberRange.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberrangeformatter.h instead.
 *
 * @stable ICU 68
 */
typedef struct UFormattedNumberRange UFormattedNumberRange;


/**
 * Creates a new UNumberFormatter for the given skeleton string, collapse option, identity fallback
 * option, and locale. This is currently the only method for creating a new UNumberRangeFormatter.
 *
 * Objects of type UNumberRangeFormatter returned by this method are threadsafe.
 *
 * For more details on skeleton strings, see the documentation in numberrangeformatter.h. For more
 * details on the usage of this API, see the documentation at the top of unumberrangeformatter.h.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberrangeformatter.h instead.
 *
 * @param skeleton The skeleton string, like u"percent precision-integer"
 * @param skeletonLen The number of UChars in the skeleton string, or -1 if it is NUL-terminated.
 * @param collapse Option for how to merge affixes (if unsure, use UNUM_RANGE_COLLAPSE_AUTO)
 * @param identityFallback Option for resolving when both sides of the range are equal.
 * @param locale The NUL-terminated locale ID.
 * @param perror A parse error struct populated if an error occurs when parsing. Can be NULL.
 *               If no error occurs, perror->offset will be set to -1.
 * @param ec Set if an error occurs.
 * @stable ICU 68
 */
U_CAPI UNumberRangeFormatter* U_EXPORT2
unumrf_openForSkeletonWithCollapseAndIdentityFallback(
    const UChar* skeleton,
    int32_t skeletonLen,
    UNumberRangeCollapse collapse,
    UNumberRangeIdentityFallback identityFallback,
    const char* locale,
    UParseError* perror,
    UErrorCode* ec);


/**
 * Creates an object to hold the result of a UNumberRangeFormatter
 * operation. The object can be used repeatedly; it is cleared whenever
 * passed to a format function.
 *
 * @param ec Set if an error occurs.
 * @stable ICU 68
 */
U_CAPI UFormattedNumberRange* U_EXPORT2
unumrf_openResult(UErrorCode* ec);


/**
 * Uses a UNumberRangeFormatter to format a range of doubles.
 *
 * The UNumberRangeFormatter can be shared between threads. Each thread should have its own local
 * UFormattedNumberRange, however, for storing the result of the formatting operation.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberrangeformatter.h instead.
 *
 * @param uformatter A formatter object; see unumberrangeformatter.h.
 * @param first The first (usually smaller) number in the range.
 * @param second The second (usually larger) number in the range.
 * @param uresult The object that will be mutated to store the result; see unumrf_openResult.
 * @param ec Set if an error occurs.
 * @stable ICU 68
 */
U_CAPI void U_EXPORT2
unumrf_formatDoubleRange(
    const UNumberRangeFormatter* uformatter,
    double first,
    double second,
    UFormattedNumberRange* uresult,
    UErrorCode* ec);


/**
 * Uses a UNumberRangeFormatter to format a range of decimal numbers.
 *
 * With a decimal number string, you can specify an input with arbitrary precision.
 *
 * The UNumberRangeFormatter can be shared between threads. Each thread should have its own local
 * UFormattedNumberRange, however, for storing the result of the formatting operation.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberrangeformatter.h instead.
 *
 * @param uformatter A formatter object; see unumberrangeformatter.h.
 * @param first The first (usually smaller) number in the range.
 * @param firstLen The length of the first decimal number string.
 * @param second The second (usually larger) number in the range.
 * @param secondLen The length of the second decimal number string.
 * @param uresult The object that will be mutated to store the result; see unumrf_openResult.
 * @param ec Set if an error occurs.
 * @stable ICU 68
 */
U_CAPI void U_EXPORT2
unumrf_formatDecimalRange(
    const UNumberRangeFormatter* uformatter,
    const char* first,
    int32_t firstLen,
    const char* second,
    int32_t secondLen,
    UFormattedNumberRange* uresult,
    UErrorCode* ec);


/**
 * Returns a representation of a UFormattedNumberRange as a UFormattedValue,
 * which can be subsequently passed to any API requiring that type.
 *
 * The returned object is owned by the UFormattedNumberRange and is valid
 * only as long as the UFormattedNumber is present and unchanged in memory.
 *
 * You can think of this method as a cast between types.
 *
 * @param uresult The object containing the formatted number range.
 * @param ec Set if an error occurs.
 * @return A UFormattedValue owned by the input object.
 * @stable ICU 68
 */
U_CAPI const UFormattedValue* U_EXPORT2
unumrf_resultAsValue(const UFormattedNumberRange* uresult, UErrorCode* ec);


/**
 * Extracts the identity result from a UFormattedNumberRange.
 *
 * NOTE: This is a C-compatible API; C++ users should build against numberformatter.h instead.
 *
 * @param uresult The object containing the formatted number range.
 * @param ec Set if an error occurs.
 * @return The identity result; see UNumberRangeIdentityResult.
 * @stable ICU 68
 */
U_CAPI UNumberRangeIdentityResult U_EXPORT2
unumrf_resultGetIdentityResult(
    const UFormattedNumberRange* uresult,
    UErrorCode* ec);


/**
 * Extracts the first formatted number as a decimal number. This endpoint
 * is useful for obtaining the exact number being printed after scaling
 * and rounding have been applied by the number range formatting pipeline.
 * 
 * The syntax of the unformatted number is a "numeric string"
 * as defined in the Decimal Arithmetic Specification, available at
 * http://speleotrove.com/decimal
 *
 * @param  uresult       The input object containing the formatted number range.
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
unumrf_resultGetFirstDecimalNumber(
    const UFormattedNumberRange* uresult,
    char* dest,
    int32_t destCapacity,
    UErrorCode* ec);


/**
 * Extracts the second formatted number as a decimal number. This endpoint
 * is useful for obtaining the exact number being printed after scaling
 * and rounding have been applied by the number range formatting pipeline.
 * 
 * The syntax of the unformatted number is a "numeric string"
 * as defined in the Decimal Arithmetic Specification, available at
 * http://speleotrove.com/decimal
 *
 * @param  uresult       The input object containing the formatted number range.
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
unumrf_resultGetSecondDecimalNumber(
    const UFormattedNumberRange* uresult,
    char* dest,
    int32_t destCapacity,
    UErrorCode* ec);


/**
 * Releases the UNumberFormatter created by unumf_openForSkeletonAndLocale().
 *
 * @param uformatter An object created by unumf_openForSkeletonAndLocale().
 * @stable ICU 68
 */
U_CAPI void U_EXPORT2
unumrf_close(UNumberRangeFormatter* uformatter);


/**
 * Releases the UFormattedNumber created by unumf_openResult().
 *
 * @param uresult An object created by unumf_openResult().
 * @stable ICU 68
 */
U_CAPI void U_EXPORT2
unumrf_closeResult(UFormattedNumberRange* uresult);


#if U_SHOW_CPLUSPLUS_API
U_NAMESPACE_BEGIN

/**
 * \class LocalUNumberRangeFormatterPointer
 * "Smart pointer" class; closes a UNumberFormatter via unumf_close().
 * For most methods see the LocalPointerBase base class.
 *
 * Usage:
 * <pre>
 * LocalUNumberRangeFormatterPointer uformatter(
 *     unumrf_openForSkeletonCollapseIdentityFallbackAndLocaleWithError(...));
 * // no need to explicitly call unumrf_close()
 * </pre>
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 68
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUNumberRangeFormatterPointer, UNumberRangeFormatter, unumrf_close);

/**
 * \class LocalUFormattedNumberPointer
 * "Smart pointer" class; closes a UFormattedNumber via unumf_closeResult().
 * For most methods see the LocalPointerBase base class.
 *
 * Usage:
 * <pre>
 * LocalUFormattedNumberRangePointer uresult(unumrf_openResult(...));
 * // no need to explicitly call unumrf_closeResult()
 * </pre>
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 68
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattedNumberRangePointer, UFormattedNumberRange, unumrf_closeResult);

U_NAMESPACE_END
#endif // U_SHOW_CPLUSPLUS_API

#endif /* #if !UCONFIG_NO_FORMATTING */
#endif //__UNUMBERRANGEFORMATTER_H__
