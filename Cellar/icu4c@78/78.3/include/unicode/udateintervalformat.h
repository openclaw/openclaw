// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2010-2012,2015 International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef UDATEINTERVALFORMAT_H
#define UDATEINTERVALFORMAT_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/ucal.h"
#include "unicode/umisc.h"
#include "unicode/uformattedvalue.h"
#include "unicode/udisplaycontext.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Format a date interval.
 *
 * A UDateIntervalFormat is used to format the range between two UDate values
 * in a locale-sensitive way, using a skeleton that specifies the precision and
 * completeness of the information to show. If the range smaller than the resolution
 * specified by the skeleton, a single date format will be produced. If the range
 * is larger than the format specified by the skeleton, a locale-specific fallback
 * will be used to format the items missing from the skeleton.
 *
 * For example, if the range is 2010-03-04 07:56 - 2010-03-04 19:56 (12 hours)
 * - The skeleton jm will produce
 *   for en_US, "7:56 AM - 7:56 PM"
 *   for en_GB, "7:56 - 19:56"
 * - The skeleton MMMd will produce
 *   for en_US, "Mar 4"
 *   for en_GB, "4 Mar"
 * If the range is 2010-03-04 07:56 - 2010-03-08 16:11 (4 days, 8 hours, 15 minutes)
 * - The skeleton jm will produce
 *   for en_US, "3/4/2010 7:56 AM - 3/8/2010 4:11 PM"
 *   for en_GB, "4/3/2010 7:56 - 8/3/2010 16:11"
 * - The skeleton MMMd will produce
 *   for en_US, "Mar 4-8"
 *   for en_GB, "4-8 Mar"
 * 
 * Note:  the "-" characters in the above sample output will actually be
 * Unicode 2013, EN_DASH, in all but the last example.
 *
 * Note, in ICU 4.4 the standard skeletons for which date interval format data
 * is usually available are as follows; best results will be obtained by using
 * skeletons from this set, or those formed by combining these standard skeletons
 * (note that for these skeletons, the length of digit field such as d, y, or
 * M vs MM is irrelevant (but for non-digit fields such as MMM vs MMMM it is
 * relevant). Note that a skeleton involving h or H generally explicitly requests
 * that time style (12- or 24-hour time respectively). For a skeleton that
 * requests the locale's default time style (h or H), use 'j' instead of h or H.
 *   h, H, hm, Hm,
 *   hv, Hv, hmv, Hmv,
 *   d,
 *   M, MMM, MMMM,
 *   Md, MMMd,
 *   MEd, MMMEd,
 *   y,
 *   yM, yMMM, yMMMM,
 *   yMd, yMMMd,
 *   yMEd, yMMMEd
 *
 * Locales for which ICU 4.4 seems to have a reasonable amount of this data
 * include:
 *   af, am, ar, be, bg, bn, ca, cs, da, de (_AT), el, en (_AU,_CA,_GB,_IE,_IN...),
 *   eo, es (_AR,_CL,_CO,...,_US) et, fa, fi, fo, fr (_BE,_CH,_CA), fur, gsw, he,
 *   hr, hu, hy, is, it (_CH), ja, kk, km, ko, lt, lv, mk, ml, mt, nb, nl )_BE),
 *   nn, pl, pt (_PT), rm, ro, ru (_UA), sk, sl, so, sq, sr, sr_Latn, sv, th, to,
 *   tr, uk, ur, vi, zh (_SG), zh_Hant (_HK,_MO)
 */

/**
 * Opaque UDateIntervalFormat object for use in C programs.
 * @stable ICU 4.8
 */
struct UDateIntervalFormat;
typedef struct UDateIntervalFormat UDateIntervalFormat;  /**< C typedef for struct UDateIntervalFormat. @stable ICU 4.8 */

struct UFormattedDateInterval;
/**
 * Opaque struct to contain the results of a UDateIntervalFormat operation.
 * @stable ICU 64
 */
typedef struct UFormattedDateInterval UFormattedDateInterval;

/**
 * Open a new UDateIntervalFormat object using the predefined rules for a
 * given locale plus a specified skeleton.
 * @param locale
 *            The locale for whose rules should be used; may be NULL for
 *            default locale.
 * @param skeleton
 *            A pattern containing only the fields desired for the interval
 *            format, for example "Hm", "yMMMd", or "yMMMEdHm".
 * @param skeletonLength
 *            The length of skeleton; may be -1 if the skeleton is zero-terminated.
 * @param tzID
 *            A timezone ID specifying the timezone to use. If 0, use the default
 *            timezone.
 * @param tzIDLength
 *            The length of tzID, or -1 if null-terminated. If 0, use the default
 *            timezone.
 * @param status
 *            A pointer to a UErrorCode to receive any errors.
 * @return
 *            A pointer to a UDateIntervalFormat object for the specified locale,
 *            or NULL if an error occurred.
 * @stable ICU 4.8
 */
U_CAPI UDateIntervalFormat* U_EXPORT2
udtitvfmt_open(const char*  locale,
              const UChar* skeleton,
              int32_t      skeletonLength,
              const UChar* tzID,
              int32_t      tzIDLength,
              UErrorCode*  status);

/**
 * Close a UDateIntervalFormat object. Once closed it may no longer be used.
 * @param formatter
 *            The UDateIntervalFormat object to close.
 * @stable ICU 4.8
 */
U_CAPI void U_EXPORT2
udtitvfmt_close(UDateIntervalFormat *formatter);

/**
 * Creates an object to hold the result of a UDateIntervalFormat
 * operation. The object can be used repeatedly; it is cleared whenever
 * passed to a format function.
 *
 * @param ec Set if an error occurs.
 * @return A pointer needing ownership.
 * @stable ICU 64
 */
U_CAPI UFormattedDateInterval* U_EXPORT2
udtitvfmt_openResult(UErrorCode* ec);

/**
 * Returns a representation of a UFormattedDateInterval as a UFormattedValue,
 * which can be subsequently passed to any API requiring that type.
 *
 * The returned object is owned by the UFormattedDateInterval and is valid
 * only as long as the UFormattedDateInterval is present and unchanged in memory.
 *
 * You can think of this method as a cast between types.
 *
 * When calling ufmtval_nextPosition():
 * The fields are returned from left to right. The special field category
 * UFIELD_CATEGORY_DATE_INTERVAL_SPAN is used to indicate which datetime
 * primitives came from which arguments: 0 means fromCalendar, and 1 means
 * toCalendar. The span category will always occur before the
 * corresponding fields in UFIELD_CATEGORY_DATE
 * in the ufmtval_nextPosition() iterator.
 *
 * @param uresult The object containing the formatted string.
 * @param ec Set if an error occurs.
 * @return A UFormattedValue owned by the input object.
 * @stable ICU 64
 */
U_CAPI const UFormattedValue* U_EXPORT2
udtitvfmt_resultAsValue(const UFormattedDateInterval* uresult, UErrorCode* ec);

/**
 * Releases the UFormattedDateInterval created by udtitvfmt_openResult().
 *
 * @param uresult The object to release.
 * @stable ICU 64
 */
U_CAPI void U_EXPORT2
udtitvfmt_closeResult(UFormattedDateInterval* uresult);


#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUDateIntervalFormatPointer
 * "Smart pointer" class, closes a UDateIntervalFormat via udtitvfmt_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.8
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUDateIntervalFormatPointer, UDateIntervalFormat, udtitvfmt_close);

/**
 * \class LocalUFormattedDateIntervalPointer
 * "Smart pointer" class, closes a UFormattedDateInterval via udtitvfmt_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 64
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUFormattedDateIntervalPointer, UFormattedDateInterval, udtitvfmt_closeResult);

U_NAMESPACE_END

#endif


/**
 * Formats a date/time range using the conventions established for the
 * UDateIntervalFormat object.
 * @param formatter
 *            The UDateIntervalFormat object specifying the format conventions.
 * @param fromDate
 *            The starting point of the range.
 * @param toDate
 *            The ending point of the range.
 * @param result
 *            A pointer to a buffer to receive the formatted range.
 * @param resultCapacity
 *            The maximum size of result.
 * @param position
 *            A pointer to a UFieldPosition. On input, position->field is read.
 *            On output, position->beginIndex and position->endIndex indicate
 *            the beginning and ending indices of field number position->field,
 *            if such a field exists. This parameter may be NULL, in which case
 *            no field position data is returned.
 *            There may be multiple instances of a given field type in an
 *            interval format; in this case the position indices refer to the
 *            first instance.
 * @param status
 *            A pointer to a UErrorCode to receive any errors.
 * @return
 *            The total buffer size needed; if greater than resultLength, the
 *            output was truncated.
 * @stable ICU 4.8
 */
U_CAPI int32_t U_EXPORT2
udtitvfmt_format(const UDateIntervalFormat* formatter,
                UDate           fromDate,
                UDate           toDate,
                UChar*          result,
                int32_t         resultCapacity,
                UFieldPosition* position,
                UErrorCode*     status);


/**
 * Formats a date/time range using the conventions established for the
 * UDateIntervalFormat object.
 * @param formatter
 *            The UDateIntervalFormat object specifying the format conventions.
 * @param fromDate
 *            The starting point of the range.
 * @param toDate
 *            The ending point of the range.
 * @param result
 *            The UFormattedDateInterval to contain the result of the
 *            formatting operation.
 * @param status
 *            A pointer to a UErrorCode to receive any errors.
 * @stable ICU 67
 */
U_CAPI void U_EXPORT2
udtitvfmt_formatToResult(
                const UDateIntervalFormat* formatter,
                UDate           fromDate,
                UDate           toDate,
                UFormattedDateInterval* result,
                UErrorCode*     status);

/**
 * Formats a date/time range using the conventions established for the
 * UDateIntervalFormat object.
 * @param formatter
 *            The UDateIntervalFormat object specifying the format conventions.
 * @param fromCalendar
 *            The starting point of the range.
 * @param toCalendar
 *            The ending point of the range.
 * @param result
 *            The UFormattedDateInterval to contain the result of the
 *            formatting operation.
 * @param status
 *            A pointer to a UErrorCode to receive any errors.
 * @stable ICU 67
 */

U_CAPI void U_EXPORT2
udtitvfmt_formatCalendarToResult(
                const UDateIntervalFormat* formatter,
                UCalendar*      fromCalendar,
                UCalendar*      toCalendar,
                UFormattedDateInterval* result,
                UErrorCode*     status);

/**
 * Set a particular UDisplayContext value in the formatter, such as
 * UDISPCTX_CAPITALIZATION_FOR_STANDALONE. This causes the formatted
 * result to be capitalized appropriately for the context in which
 * it is intended to be used, considering both the locale and the
 * type of field at the beginning of the formatted result.
 * @param formatter The formatter for which to set a UDisplayContext value.
 * @param value The UDisplayContext value to set.
 * @param status A pointer to an UErrorCode to receive any errors
 * @stable ICU 68
 */
U_CAPI void U_EXPORT2
udtitvfmt_setContext(UDateIntervalFormat* formatter, UDisplayContext value, UErrorCode* status);

/**
 * Get the formatter's UDisplayContext value for the specified UDisplayContextType,
 * such as UDISPCTX_TYPE_CAPITALIZATION.
 * @param formatter The formatter to query.
 * @param type The UDisplayContextType whose value to return
 * @param status A pointer to an UErrorCode to receive any errors
 * @return The UDisplayContextValue for the specified type.
 * @stable ICU 68
 */
U_CAPI UDisplayContext U_EXPORT2
udtitvfmt_getContext(const UDateIntervalFormat* formatter, UDisplayContextType type, UErrorCode* status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
