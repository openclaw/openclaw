// © 2017 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __UNUMBEROPTIONS_H__
#define __UNUMBEROPTIONS_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

/**
 * \file
 * \brief C API: Header-only input options for various number formatting APIs.
 *
 * You do not normally need to include this header file directly, because it is included in all
 * files that use these enums.
 */


/** The possible number format rounding modes.
 *
 * <p>
 * For more detail on rounding modes, see:
 * https://unicode-org.github.io/icu/userguide/format_parse/numbers/rounding-modes
 *
 * @stable ICU 2.0
 */
typedef enum UNumberFormatRoundingMode {
    UNUM_ROUND_CEILING,
    UNUM_ROUND_FLOOR,
    UNUM_ROUND_DOWN,
    UNUM_ROUND_UP,
    /**
     * Half-even rounding
     * @stable, ICU 3.8
     */
    UNUM_ROUND_HALFEVEN,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * Half-even rounding, misspelled name
     * @deprecated, ICU 3.8
     */
    UNUM_FOUND_HALFEVEN = UNUM_ROUND_HALFEVEN,
#endif  /* U_HIDE_DEPRECATED_API */
    UNUM_ROUND_HALFDOWN = UNUM_ROUND_HALFEVEN + 1,
    UNUM_ROUND_HALFUP,
    /** 
      * ROUND_UNNECESSARY reports an error if formatted result is not exact.
      * @stable ICU 4.8
      */
    UNUM_ROUND_UNNECESSARY,
    /**
     * Rounds ties toward the odd number.
     * @stable ICU 69
     */
    UNUM_ROUND_HALF_ODD,
    /**
     * Rounds ties toward +∞.
     * @stable ICU 69
     */
    UNUM_ROUND_HALF_CEILING,
    /**
     * Rounds ties toward -∞.
     * @stable ICU 69
     */
    UNUM_ROUND_HALF_FLOOR,
} UNumberFormatRoundingMode;


/**
 * An enum declaring the strategy for when and how to display grouping separators (i.e., the
 * separator, often a comma or period, after every 2-3 powers of ten). The choices are several
 * pre-built strategies for different use cases that employ locale data whenever possible. Example
 * outputs for 1234 and 1234567 in <em>en-IN</em>:
 *
 * <ul>
 * <li>OFF: 1234 and 12345
 * <li>MIN2: 1234 and 12,34,567
 * <li>AUTO: 1,234 and 12,34,567
 * <li>ON_ALIGNED: 1,234 and 12,34,567
 * <li>THOUSANDS: 1,234 and 1,234,567
 * </ul>
 *
 * <p>
 * The default is AUTO, which displays grouping separators unless the locale data says that grouping
 * is not customary. To force grouping for all numbers greater than 1000 consistently across locales,
 * use ON_ALIGNED. On the other hand, to display grouping less frequently than the default, use MIN2
 * or OFF. See the docs of each option for details.
 *
 * <p>
 * Note: This enum specifies the strategy for grouping sizes. To set which character to use as the
 * grouping separator, use the "symbols" setter.
 *
 * @stable ICU 63
 */
typedef enum UNumberGroupingStrategy {
    /**
     * Do not display grouping separators in any locale.
     *
     * @stable ICU 61
     */
            UNUM_GROUPING_OFF,

    /**
     * Display grouping using locale defaults, except do not show grouping on values smaller than
     * 10000 (such that there is a <em>minimum of two digits</em> before the first separator).
     *
     * <p>
     * Note that locales may restrict grouping separators to be displayed only on 1 million or
     * greater (for example, ee and hu) or disable grouping altogether (for example, bg currency).
     *
     * <p>
     * Locale data is used to determine whether to separate larger numbers into groups of 2
     * (customary in South Asia) or groups of 3 (customary in Europe and the Americas).
     *
     * @stable ICU 61
     */
            UNUM_GROUPING_MIN2,

    /**
     * Display grouping using the default strategy for all locales. This is the default behavior.
     *
     * <p>
     * Note that locales may restrict grouping separators to be displayed only on 1 million or
     * greater (for example, ee and hu) or disable grouping altogether (for example, bg currency).
     *
     * <p>
     * Locale data is used to determine whether to separate larger numbers into groups of 2
     * (customary in South Asia) or groups of 3 (customary in Europe and the Americas).
     *
     * @stable ICU 61
     */
            UNUM_GROUPING_AUTO,

    /**
     * Always display the grouping separator on values of at least 1000.
     *
     * <p>
     * This option ignores the locale data that restricts or disables grouping, described in MIN2 and
     * AUTO. This option may be useful to normalize the alignment of numbers, such as in a
     * spreadsheet.
     *
     * <p>
     * Locale data is used to determine whether to separate larger numbers into groups of 2
     * (customary in South Asia) or groups of 3 (customary in Europe and the Americas).
     *
     * @stable ICU 61
     */
            UNUM_GROUPING_ON_ALIGNED,

    /**
     * Use the Western defaults: groups of 3 and enabled for all numbers 1000 or greater. Do not use
     * locale data for determining the grouping strategy.
     *
     * @stable ICU 61
     */
            UNUM_GROUPING_THOUSANDS

#ifndef U_HIDE_INTERNAL_API
    ,
    /**
     * One more than the highest UNumberGroupingStrategy value.
     *
     * @internal ICU 62: The numeric value may change over time; see ICU ticket #12420.
     */
            UNUM_GROUPING_COUNT
#endif  /* U_HIDE_INTERNAL_API */

} UNumberGroupingStrategy;


#endif /* #if !UCONFIG_NO_FORMATTING */
#endif //__UNUMBEROPTIONS_H__
