// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2004 - 2008, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*/

#ifndef UTMSCALE_H
#define UTMSCALE_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

/** 
 * \file
 * \brief C API: Universal Time Scale
 *
 * There are quite a few different conventions for binary datetime, depending on different
 * platforms and protocols. Some of these have severe drawbacks. For example, people using
 * Unix time (seconds since Jan 1, 1970) think that they are safe until near the year 2038.
 * But cases can and do arise where arithmetic manipulations causes serious problems. Consider
 * the computation of the average of two datetimes, for example: if one calculates them with
 * <code>averageTime = (time1 + time2)/2</code>, there will be overflow even with dates
 * around the present. Moreover, even if these problems don't occur, there is the issue of
 * conversion back and forth between different systems.
 *
 * <p>
 * Binary datetimes differ in a number of ways: the datatype, the unit,
 * and the epoch (origin). We'll refer to these as time scales. For example:
 *
 * <table border="1" cellspacing="0" cellpadding="4">
 *  <caption>Table 1: Binary Time Scales</caption>
 *  <tr>
 *    <th align="left">Source</th>
 *    <th align="left">Datatype</th>
 *    <th align="left">Unit</th>
 *    <th align="left">Epoch</th>
 *  </tr>
 *
 *  <tr>
 *    <td>UDTS_JAVA_TIME</td>
 *    <td>int64_t</td>
 *    <td>milliseconds</td>
 *    <td>Jan 1, 1970</td>
 *  </tr>
 *  <tr>
 *
 *    <td>UDTS_UNIX_TIME</td>
 *    <td>int32_t or int64_t</td>
 *    <td>seconds</td>
 *    <td>Jan 1, 1970</td>
 *  </tr>
 *  <tr>
 *    <td>UDTS_ICU4C_TIME</td>
 *
 *    <td>double</td>
 *    <td>milliseconds</td>
 *    <td>Jan 1, 1970</td>
 *  </tr>
 *  <tr>
 *    <td>UDTS_WINDOWS_FILE_TIME</td>
 *    <td>int64_t</td>
 *
 *    <td>ticks (100 nanoseconds)</td>
 *    <td>Jan 1, 1601</td>
 *  </tr>
 *  <tr>
 *    <td>UDTS_DOTNET_DATE_TIME</td>
 *    <td>int64_t</td>
 *    <td>ticks (100 nanoseconds)</td>
 *
 *    <td>Jan 1, 0001</td>
 *  </tr>
 *  <tr>
 *    <td>UDTS_MAC_OLD_TIME</td>
 *    <td>int32_t or int64_t</td>
 *    <td>seconds</td>
 *    <td>Jan 1, 1904</td>
 *
 *  </tr>
 *  <tr>
 *    <td>UDTS_MAC_TIME</td>
 *    <td>double</td>
 *    <td>seconds</td>
 *    <td>Jan 1, 2001</td>
 *  </tr>
 *
 *  <tr>
 *    <td>UDTS_EXCEL_TIME</td>
 *    <td>?</td>
 *    <td>days</td>
 *    <td>Dec 31, 1899</td>
 *  </tr>
 *  <tr>
 *
 *    <td>UDTS_DB2_TIME</td>
 *    <td>?</td>
 *    <td>days</td>
 *    <td>Dec 31, 1899</td>
 *  </tr>
 *
 *  <tr>
 *    <td>UDTS_UNIX_MICROSECONDS_TIME</td>
 *    <td>int64_t</td>
 *    <td>microseconds</td>
 *    <td>Jan 1, 1970</td>
 *  </tr>
 * </table>
 *
 * <p>
 * All of the epochs start at 00:00 am (the earliest possible time on the day in question),
 * and are assumed to be UTC.
 *
 * <p>
 * The ranges for different datatypes are given in the following table (all values in years).
 * The range of years includes the entire range expressible with positive and negative
 * values of the datatype. The range of years for double is the range that would be allowed
 * without losing precision to the corresponding unit.
 *
 * <table border="1" cellspacing="0" cellpadding="4">
 *  <tr>
 *    <th align="left">Units</th>
 *    <th align="left">int64_t</th>
 *    <th align="left">double</th>
 *    <th align="left">int32_t</th>
 *  </tr>
 *
 *  <tr>
 *    <td>1 sec</td>
 *    <td align="right">5.84542x10<sup>11</sup></td>
 *    <td align="right">285,420,920.94</td>
 *    <td align="right">136.10</td>
 *  </tr>
 *  <tr>
 *
 *    <td>1 millisecond</td>
 *    <td align="right">584,542,046.09</td>
 *    <td align="right">285,420.92</td>
 *    <td align="right">0.14</td>
 *  </tr>
 *  <tr>
 *    <td>1 microsecond</td>
 *
 *    <td align="right">584,542.05</td>
 *    <td align="right">285.42</td>
 *    <td align="right">0.00</td>
 *  </tr>
 *  <tr>
 *    <td>100 nanoseconds (tick)</td>
 *    <td align="right">58,454.20</td>
 *    <td align="right">28.54</td>
 *    <td align="right">0.00</td>
 *  </tr>
 *  <tr>
 *    <td>1 nanosecond</td>
 *    <td align="right">584.5420461</td>
 *    <td align="right">0.2854</td>
 *    <td align="right">0.00</td>
 *  </tr>
 * </table>
 *
 * <p>
 * These functions implement a universal time scale which can be used as a 'pivot',
 * and provide conversion functions to and from all other major time scales.
 * This datetimes to be converted to the pivot time, safely manipulated,
 * and converted back to any other datetime time scale.
 *
 *<p>
 * So what to use for this pivot? Java time has plenty of range, but cannot represent
 * .NET <code>System.DateTime</code> values without severe loss of precision. ICU4C time addresses this by using a
 * <code>double</code> that is otherwise equivalent to the Java time. However, there are disadvantages
 * with <code>doubles</code>. They provide for much more graceful degradation in arithmetic operations.
 * But they only have 53 bits of accuracy, which means that they will lose precision when
 * converting back and forth to ticks. What would really be nice would be a
 * <code>long double</code> (80 bits -- 64 bit mantissa), but that is not supported on most systems.
 *
 *<p>
 * The Unix extended time uses a structure with two components: time in seconds and a
 * fractional field (microseconds). However, this is clumsy, slow, and
 * prone to error (you always have to keep track of overflow and underflow in the
 * fractional field). <code>BigDecimal</code> would allow for arbitrary precision and arbitrary range,
 * but we do not want to use this as the normal type, because it is slow and does not
 * have a fixed size.
 *
 *<p>
 * Because of these issues, we ended up concluding that the .NET framework's
 * <code>System.DateTime</code> would be the best pivot. However, we use the full range
 * allowed by the datatype, allowing for datetimes back to 29,000 BC and up to 29,000 AD.
 * This time scale is very fine grained, does not lose precision, and covers a range that
 * will meet almost all requirements. It will not handle the range that Java times do,
 * but frankly, being able to handle dates before 29,000 BC or after 29,000 AD is of very limited interest.
 *
 */

/**
 * <code>UDateTimeScale</code> values are used to specify the time scale used for
 * conversion into or out if the universal time scale.
 *
 * @stable ICU 3.2
 */
typedef enum UDateTimeScale {
    /**
     * Used in the JDK. Data is a Java <code>long</code> (<code>int64_t</code>). Value
     * is milliseconds since January 1, 1970.
     *
     * @stable ICU 3.2
     */
    UDTS_JAVA_TIME = 0,

    /**
     * Used on Unix systems. Data is <code>int32_t</code> or <code>int64_t</code>. Value
     * is seconds since January 1, 1970.
     *
     * @stable ICU 3.2
     */
    UDTS_UNIX_TIME,
    
    /**
     * Used in IUC4C. Data is a <code>double</code>. Value
     * is milliseconds since January 1, 1970.
     *
     * @stable ICU 3.2
     */
    UDTS_ICU4C_TIME,
    
    /**
     * Used in Windows for file times. Data is an <code>int64_t</code>. Value
     * is ticks (1 tick == 100 nanoseconds) since January 1, 1601.
     *
     * @stable ICU 3.2
     */
    UDTS_WINDOWS_FILE_TIME,
    
    /**
     * Used in the .NET framework's <code>System.DateTime</code> structure. Data is an <code>int64_t</code>. Value
     * is ticks (1 tick == 100 nanoseconds) since January 1, 0001.
     *
     * @stable ICU 3.2
     */
    UDTS_DOTNET_DATE_TIME,
    
    /**
     * Used in older Macintosh systems. Data is <code>int32_t</code> or <code>int64_t</code>. Value
     * is seconds since January 1, 1904.
     *
     * @stable ICU 3.2
     */
    UDTS_MAC_OLD_TIME,
    
    /**
     * Used in newer Macintosh systems. Data is a <code>double</code>. Value
     * is seconds since January 1, 2001.
     *
     * @stable ICU 3.2
     */
    UDTS_MAC_TIME,
    
    /**
     * Used in Excel. Data is an <code>?unknown?</code>. Value
     * is days since December 31, 1899.
     *
     * @stable ICU 3.2
     */
    UDTS_EXCEL_TIME,
    
    /**
     * Used in DB2. Data is an <code>?unknown?</code>. Value
     * is days since December 31, 1899.
     *
     * @stable ICU 3.2
     */
    UDTS_DB2_TIME,

    /**
     * Data is a <code>long</code>. Value is microseconds since January 1, 1970.
     * Similar to Unix time (linear value from 1970) and struct timeval
     * (microseconds resolution).
     *
     * @stable ICU 3.8
     */
    UDTS_UNIX_MICROSECONDS_TIME,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * The first unused time scale value. The limit of this enum
     * @deprecated ICU 59 The numeric value may change over time, see ICU ticket #12420.
     */
    UDTS_MAX_SCALE
#endif  /* U_HIDE_DEPRECATED_API */

} UDateTimeScale;

/**
 * <code>UTimeScaleValue</code> values are used to specify the time scale values
 * to <code>utmscale_getTimeScaleValue</code>.
 *
 * @see utmscale_getTimeScaleValue
 *
 * @stable ICU 3.2
 */
typedef enum UTimeScaleValue {
    /**
     * The constant used to select the units vale
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_UNITS_VALUE = 0,

    /**
     * The constant used to select the epoch offset value
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_EPOCH_OFFSET_VALUE=1,

    /**
     * The constant used to select the minimum from value
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_FROM_MIN_VALUE=2,

    /**
     * The constant used to select the maximum from value
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_FROM_MAX_VALUE=3,

    /**
     * The constant used to select the minimum to value
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_TO_MIN_VALUE=4,

    /**
     * The constant used to select the maximum to value
     * for a time scale.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @stable ICU 3.2
     */
    UTSV_TO_MAX_VALUE=5,

#ifndef U_HIDE_INTERNAL_API
    /**
     * The constant used to select the epoch plus one value
     * for a time scale.
     * 
     * NOTE: This is an internal value. DO NOT USE IT. May not
     * actually be equal to the epoch offset value plus one.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @internal ICU 3.2
     */
    UTSV_EPOCH_OFFSET_PLUS_1_VALUE=6,

    /**
     * The constant used to select the epoch plus one value
     * for a time scale.
     * 
     * NOTE: This is an internal value. DO NOT USE IT. May not
     * actually be equal to the epoch offset value plus one.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @internal ICU 3.2
     */
    UTSV_EPOCH_OFFSET_MINUS_1_VALUE=7,

    /**
     * The constant used to select the units round value
     * for a time scale.
     * 
     * NOTE: This is an internal value. DO NOT USE IT.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @internal ICU 3.2
     */
    UTSV_UNITS_ROUND_VALUE=8,

    /**
     * The constant used to select the minimum safe rounding value
     * for a time scale.
     * 
     * NOTE: This is an internal value. DO NOT USE IT.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @internal ICU 3.2
     */
    UTSV_MIN_ROUND_VALUE=9,

    /**
     * The constant used to select the maximum safe rounding value
     * for a time scale.
     * 
     * NOTE: This is an internal value. DO NOT USE IT.
     * 
     * @see utmscale_getTimeScaleValue
     *
     * @internal ICU 3.2
     */
    UTSV_MAX_ROUND_VALUE=10,

#endif /* U_HIDE_INTERNAL_API */

#ifndef U_HIDE_DEPRECATED_API
    /**
     * The number of time scale values, in other words limit of this enum.
     * 
     * @see utmscale_getTimeScaleValue
     * @deprecated ICU 59 The numeric value may change over time, see ICU ticket #12420.
     */
    UTSV_MAX_SCALE_VALUE=11
#endif  /* U_HIDE_DEPRECATED_API */

} UTimeScaleValue;

/**
 * Get a value associated with a particular time scale.
 * 
 * @param timeScale The time scale
 * @param value A constant representing the value to get
 * @param status The status code. Set to <code>U_ILLEGAL_ARGUMENT_ERROR</code> if arguments are invalid.
 * @return - the value.
 * 
 * @stable ICU 3.2
 */
U_CAPI int64_t U_EXPORT2
    utmscale_getTimeScaleValue(UDateTimeScale timeScale, UTimeScaleValue value, UErrorCode *status);

/* Conversion to 'universal time scale' */

/**
 * Convert a <code>int64_t</code> datetime from the given time scale to the universal time scale.
 *
 * @param otherTime The <code>int64_t</code> datetime
 * @param timeScale The time scale to convert from
 * @param status The status code. Set to <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the conversion is out of range.
 * 
 * @return The datetime converted to the universal time scale
 *
 * @stable ICU 3.2
 */
U_CAPI int64_t U_EXPORT2
    utmscale_fromInt64(int64_t otherTime, UDateTimeScale timeScale, UErrorCode *status);

/* Conversion from 'universal time scale' */

/**
 * Convert a datetime from the universal time scale to a <code>int64_t</code> in the given time scale.
 *
 * @param universalTime The datetime in the universal time scale
 * @param timeScale The time scale to convert to
 * @param status The status code. Set to <code>U_ILLEGAL_ARGUMENT_ERROR</code> if the conversion is out of range.
 * 
 * @return The datetime converted to the given time scale
 *
 * @stable ICU 3.2
 */
U_CAPI int64_t U_EXPORT2
    utmscale_toInt64(int64_t universalTime, UDateTimeScale timeScale, UErrorCode *status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif

