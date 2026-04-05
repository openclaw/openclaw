// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 1996-2015, International Business Machines Corporation and
 * others. All Rights Reserved.
 *******************************************************************************
 */

#ifndef UCAL_H
#define UCAL_H

#include "unicode/utypes.h"
#include "unicode/uenum.h"
#include "unicode/uloc.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

/**
 * \file
 * \brief C API: Calendar
 *
 * <h2>Calendar C API</h2>
 *
 * UCalendar C API is used  for converting between a <code>UDate</code> object
 * and a set of integer fields such as <code>UCAL_YEAR</code>, <code>UCAL_MONTH</code>,
 * <code>UCAL_DAY</code>, <code>UCAL_HOUR</code>, and so on.
 * (A <code>UDate</code> object represents a specific instant in
 * time with millisecond precision. See UDate
 * for information about the <code>UDate</code> .)
 *
 * <p>
 * Types of <code>UCalendar</code> interpret a <code>UDate</code>
 * according to the rules of a specific calendar system. The C API
 * provides the enum UCalendarType with UCAL_TRADITIONAL and
 * UCAL_GREGORIAN.
 * <p>
 * Like other locale-sensitive C API, calendar API  provides a
 * function, <code>ucal_open()</code>, which returns a pointer to
 * <code>UCalendar</code> whose time fields have been initialized
 * with the current date and time. We need to specify the type of
 * calendar to be opened and the  timezoneId.
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 * UCalendar *caldef;
 * UChar *tzId;
 * UErrorCode status;
 * tzId=(UChar*)malloc(sizeof(UChar) * (strlen("PST") +1) );
 * u_uastrcpy(tzId, "PST");
 * caldef=ucal_open(tzID, u_strlen(tzID), NULL, UCAL_TRADITIONAL, &status);
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * <p>
 * A <code>UCalendar</code> object can produce all the time field values
 * needed to implement the date-time formatting for a particular language
 * and calendar style (for example, Japanese-Gregorian, Japanese-Traditional).
 *
 * <p>
 * When computing a <code>UDate</code> from time fields, two special circumstances
 * may arise: there may be insufficient information to compute the
 * <code>UDate</code> (such as only year and month but no day in the month),
 * or there may be inconsistent information (such as "Tuesday, July 15, 1996"
 * -- July 15, 1996 is actually a Monday).
 *
 * <p>
 * <strong>Insufficient information.</strong> The calendar will use default
 * information to specify the missing fields. This may vary by calendar; for
 * the Gregorian calendar, the default for a field is the same as that of the
 * start of the epoch: i.e., UCAL_YEAR = 1970, UCAL_MONTH = JANUARY, UCAL_DATE = 1, etc.
 *
 * <p>
 * <strong>Inconsistent information.</strong> If fields conflict, the calendar
 * will give preference to fields set more recently. For example, when
 * determining the day, the calendar will look for one of the following
 * combinations of fields.  The most recent combination, as determined by the
 * most recently set single field, will be used.
 *
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 * UCAL_MONTH + UCAL_DAY_OF_MONTH
 * UCAL_MONTH + UCAL_WEEK_OF_MONTH + UCAL_DAY_OF_WEEK
 * UCAL_MONTH + UCAL_DAY_OF_WEEK_IN_MONTH + UCAL_DAY_OF_WEEK
 * UCAL_DAY_OF_YEAR
 * UCAL_DAY_OF_WEEK + UCAL_WEEK_OF_YEAR
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * For the time of day:
 *
 * \htmlonly<blockquote>\endhtmlonly
 * <pre>
 * \code
 * UCAL_HOUR_OF_DAY
 * UCAL_AM_PM + UCAL_HOUR
 * \endcode
 * </pre>
 * \htmlonly</blockquote>\endhtmlonly
 *
 * <p>
 * <strong>Note:</strong> for some non-Gregorian calendars, different
 * fields may be necessary for complete disambiguation. For example, a full
 * specification of the historical Arabic astronomical calendar requires year,
 * month, day-of-month <em>and</em> day-of-week in some cases.
 *
 * <p>
 * <strong>Note:</strong> There are certain possible ambiguities in
 * interpretation of certain singular times, which are resolved in the
 * following ways:
 * <ol>
 *     <li> 24:00:00 "belongs" to the following day. That is,
 *          23:59 on Dec 31, 1969 &lt; 24:00 on Jan 1, 1970 &lt; 24:01:00 on Jan 1, 1970
 *
 *     <li> Although historically not precise, midnight also belongs to "am",
 *          and noon belongs to "pm", so on the same day,
 *          12:00 am (midnight) &lt; 12:01 am, and 12:00 pm (noon) &lt; 12:01 pm
 * </ol>
 *
 * <p>
 * The date or time format strings are not part of the definition of a
 * calendar, as those must be modifiable or overridable by the user at
 * runtime. Use {@link icu::DateFormat}
 * to format dates.
 *
 * <p>
 * <code>Calendar</code> provides an API for field "rolling", where fields
 * can be incremented or decremented, but wrap around. For example, rolling the
 * month up in the date <code>December 12, <b>1996</b></code> results in
 * <code>January 12, <b>1996</b></code>.
 *
 * <p>
 * <code>Calendar</code> also provides a date arithmetic function for
 * adding the specified (signed) amount of time to a particular time field.
 * For example, subtracting 5 days from the date <code>September 12, 1996</code>
 * results in <code>September 7, 1996</code>.
 *
 * <p>
 * The Japanese calendar uses a combination of era name and year number.
 * When an emperor of Japan abdicates and a new emperor ascends the throne,
 * a new era is declared and year number is reset to 1. Even if the date of
 * abdication is scheduled ahead of time, the new era name might not be
 * announced until just before the date. In such case, ICU4C may include
 * a start date of future era without actual era name, but not enabled
 * by default. ICU4C users who want to test the behavior of the future era
 * can enable the tentative era by:
 * <ul>
 * <li>Environment variable <code>ICU_ENABLE_TENTATIVE_ERA=true</code>.</li>
 * </ul>
 *
 * @stable ICU 2.0
 */

/**
 * The time zone ID reserved for unknown time zone.
 * It behaves like the GMT/UTC time zone but has the special ID "Etc/Unknown".
 * @stable ICU 4.8
 */
#define UCAL_UNKNOWN_ZONE_ID "Etc/Unknown"

/** A calendar.
 *  For usage in C programs.
 * @stable ICU 2.0
 */
typedef void* UCalendar;

/** Possible types of UCalendars 
 * @stable ICU 2.0
 */
enum UCalendarType {
  /**
   * Despite the name, UCAL_TRADITIONAL designates the locale's default calendar,
   * which may be the Gregorian calendar or some other calendar.
   * @stable ICU 2.0
   */
  UCAL_TRADITIONAL,
  /**
   * A better name for UCAL_TRADITIONAL.
   * @stable ICU 4.2
   */
  UCAL_DEFAULT = UCAL_TRADITIONAL,
  /**
   * Unambiguously designates the Gregorian calendar for the locale.
   * @stable ICU 2.0
   */
  UCAL_GREGORIAN
};

/** @stable ICU 2.0 */
typedef enum UCalendarType UCalendarType;

/** Possible fields in a UCalendar 
 * @stable ICU 2.0
 */
enum UCalendarDateFields {
  /** 
   * Field number indicating the era, e.g., AD or BC in the Gregorian (Julian) calendar. 
   * This is a calendar-specific value.
   * @stable ICU 2.6 
   */
  UCAL_ERA,

  /**
   * Field number indicating the year. This is a calendar-specific value.
   * @stable ICU 2.6 
   */
  UCAL_YEAR,

  /**
   * Field number indicating the month. This is a calendar-specific value. 
   * The first month of the year is
   * <code>JANUARY</code>; the last depends on the number of months in a year.
   * @see #UCAL_JANUARY
   * @see #UCAL_FEBRUARY
   * @see #UCAL_MARCH
   * @see #UCAL_APRIL
   * @see #UCAL_MAY
   * @see #UCAL_JUNE
   * @see #UCAL_JULY
   * @see #UCAL_AUGUST
   * @see #UCAL_SEPTEMBER
   * @see #UCAL_OCTOBER
   * @see #UCAL_NOVEMBER
   * @see #UCAL_DECEMBER
   * @see #UCAL_UNDECIMBER
   * @stable ICU 2.6 
   */
  UCAL_MONTH,

  /**
   * Field number indicating the
   * week number within the current year.  The first week of the year, as
   * defined by <code>UCAL_FIRST_DAY_OF_WEEK</code> and <code>UCAL_MINIMAL_DAYS_IN_FIRST_WEEK</code>
   * attributes, has value 1.  Subclasses define
   * the value of <code>UCAL_WEEK_OF_YEAR</code> for days before the first week of
   * the year.
   * @see ucal_getAttribute
   * @see ucal_setAttribute
   * @stable ICU 2.6 
   */
  UCAL_WEEK_OF_YEAR,

 /**
   * Field number indicating the
   * week number within the current month.  The first week of the month, as
   * defined by <code>UCAL_FIRST_DAY_OF_WEEK</code> and <code>UCAL_MINIMAL_DAYS_IN_FIRST_WEEK</code>
   * attributes, has value 1.  Subclasses define
   * the value of <code>WEEK_OF_MONTH</code> for days before the first week of
   * the month.
   * @see ucal_getAttribute
   * @see ucal_setAttribute
   * @see #UCAL_FIRST_DAY_OF_WEEK
   * @see #UCAL_MINIMAL_DAYS_IN_FIRST_WEEK
   * @stable ICU 2.6 
   */
  UCAL_WEEK_OF_MONTH,

 /**
   * Field number indicating the
   * day of the month. This is a synonym for <code>DAY_OF_MONTH</code>.
   * The first day of the month has value 1.
   * @see #UCAL_DAY_OF_MONTH
   * @stable ICU 2.6 
   */
  UCAL_DATE,

 /**
   * Field number indicating the day
   * number within the current year.  The first day of the year has value 1.
   * @stable ICU 2.6 
   */
  UCAL_DAY_OF_YEAR,

 /**
   * Field number indicating the day
   * of the week.  This field takes values <code>SUNDAY</code>,
   * <code>MONDAY</code>, <code>TUESDAY</code>, <code>WEDNESDAY</code>,
   * <code>THURSDAY</code>, <code>FRIDAY</code>, and <code>SATURDAY</code>.
   * @see #UCAL_SUNDAY
   * @see #UCAL_MONDAY
   * @see #UCAL_TUESDAY
   * @see #UCAL_WEDNESDAY
   * @see #UCAL_THURSDAY
   * @see #UCAL_FRIDAY
   * @see #UCAL_SATURDAY
   * @stable ICU 2.6 
   */
  UCAL_DAY_OF_WEEK,

 /**
   * Field number indicating the
   * ordinal number of the day of the week within the current month. Together
   * with the <code>DAY_OF_WEEK</code> field, this uniquely specifies a day
   * within a month.  Unlike <code>WEEK_OF_MONTH</code> and
   * <code>WEEK_OF_YEAR</code>, this field's value does <em>not</em> depend on
   * <code>getFirstDayOfWeek()</code> or
   * <code>getMinimalDaysInFirstWeek()</code>.  <code>DAY_OF_MONTH 1</code>
   * through <code>7</code> always correspond to <code>DAY_OF_WEEK_IN_MONTH
   * 1</code>; <code>8</code> through <code>15</code> correspond to
   * <code>DAY_OF_WEEK_IN_MONTH 2</code>, and so on.
   * <code>DAY_OF_WEEK_IN_MONTH 0</code> indicates the week before
   * <code>DAY_OF_WEEK_IN_MONTH 1</code>.  Negative values count back from the
   * end of the month, so the last Sunday of a month is specified as
   * <code>DAY_OF_WEEK = SUNDAY, DAY_OF_WEEK_IN_MONTH = -1</code>.  Because
   * negative values count backward they will usually be aligned differently
   * within the month than positive values.  For example, if a month has 31
   * days, <code>DAY_OF_WEEK_IN_MONTH -1</code> will overlap
   * <code>DAY_OF_WEEK_IN_MONTH 5</code> and the end of <code>4</code>.
   * @see #UCAL_DAY_OF_WEEK
   * @see #UCAL_WEEK_OF_MONTH
   * @stable ICU 2.6 
   */
  UCAL_DAY_OF_WEEK_IN_MONTH,

 /**
   * Field number indicating
   * whether the <code>HOUR</code> is before or after noon.
   * E.g., at 10:04:15.250 PM the <code>AM_PM</code> is <code>PM</code>.
   * @see #UCAL_AM
   * @see #UCAL_PM
   * @see #UCAL_HOUR
   * @stable ICU 2.6 
   */
  UCAL_AM_PM,

 /**
   * Field number indicating the
   * hour of the morning or afternoon. <code>HOUR</code> is used for the 12-hour
   * clock.
   * E.g., at 10:04:15.250 PM the <code>HOUR</code> is 10.
   * @see #UCAL_AM_PM
   * @see #UCAL_HOUR_OF_DAY
   * @stable ICU 2.6 
   */
  UCAL_HOUR,

 /**
   * Field number indicating the
   * hour of the day. <code>HOUR_OF_DAY</code> is used for the 24-hour clock.
   * E.g., at 10:04:15.250 PM the <code>HOUR_OF_DAY</code> is 22.
   * @see #UCAL_HOUR
   * @stable ICU 2.6 
   */
  UCAL_HOUR_OF_DAY,

 /**
   * Field number indicating the
   * minute within the hour.
   * E.g., at 10:04:15.250 PM the <code>UCAL_MINUTE</code> is 4.
   * @stable ICU 2.6 
   */
  UCAL_MINUTE,

 /**
   * Field number indicating the
   * second within the minute.
   * E.g., at 10:04:15.250 PM the <code>UCAL_SECOND</code> is 15.
   * @stable ICU 2.6 
   */
  UCAL_SECOND,

 /**
   * Field number indicating the
   * millisecond within the second.
   * E.g., at 10:04:15.250 PM the <code>UCAL_MILLISECOND</code> is 250.
   * @stable ICU 2.6 
   */
  UCAL_MILLISECOND,

 /**
   * Field number indicating the
   * raw offset from GMT in milliseconds.
   * @stable ICU 2.6 
   */
  UCAL_ZONE_OFFSET,

 /**
   * Field number indicating the
   * daylight savings offset in milliseconds.
   * @stable ICU 2.6 
   */
  UCAL_DST_OFFSET,
  
 /**
   * Field number 
   * indicating the extended year corresponding to the
   * <code>UCAL_WEEK_OF_YEAR</code> field.  This may be one greater or less
   * than the value of <code>UCAL_EXTENDED_YEAR</code>.
   * @stable ICU 2.6
   */
  UCAL_YEAR_WOY,

 /**
   * Field number 
   * indicating the localized day of week.  This will be a value from 1
   * to 7 inclusive, with 1 being the localized first day of the week.
   * @stable ICU 2.6
   */
  UCAL_DOW_LOCAL,

  /**
   * Year of this calendar system, encompassing all supra-year fields. For example, 
   * in Gregorian/Julian calendars, positive Extended Year values indicate years AD,
   *  1 BC = 0 extended, 2 BC = -1 extended, and so on. 
   * @stable ICU 2.8 
   */
  UCAL_EXTENDED_YEAR,

 /**
   * Field number 
   * indicating the modified Julian day number.  This is different from
   * the conventional Julian day number in two regards.  First, it
   * demarcates days at local zone midnight, rather than noon GMT.
   * Second, it is a local number; that is, it depends on the local time
   * zone.  It can be thought of as a single number that encompasses all
   * the date-related fields.
   * @stable ICU 2.8
   */
  UCAL_JULIAN_DAY, 

  /**
   * Ranges from 0 to 23:59:59.999 (regardless of DST).  This field behaves <em>exactly</em> 
   * like a composite of all time-related fields, not including the zone fields.  As such, 
   * it also reflects discontinuities of those fields on DST transition days.  On a day
   * of DST onset, it will jump forward.  On a day of DST cessation, it will jump 
   * backward.  This reflects the fact that it must be combined with the DST_OFFSET field
   * to obtain a unique local time value.
   * @stable ICU 2.8
   */
  UCAL_MILLISECONDS_IN_DAY,

  /**
   * Whether or not the current month is a leap month (0 or 1). See the Chinese calendar for
   * an example of this.
   */
  UCAL_IS_LEAP_MONTH,

  /**
   * Field number indicating the month. This is a calendar-specific value.
   * Differ from UCAL_MONTH, this value is continuous and unique within a
   * year and range from 0 to 11 or 0 to 12 depending on how many months in a
   * year, the calendar system has leap month or not, and in leap year or not.
   * It is the ordinal position of that month in the corresponding year of
   * the calendar. For Chinese, Dangi, and Hebrew calendar, the range is
   * 0 to 11 in non-leap years and 0 to 12 in leap years. For Coptic and Ethiopian
   * calendar, the range is always 0 to 12. For other calendars supported by
   * ICU now, the range is 0 to 11. When the number of months in a year of the
   * identified calendar is variable, a different UCAL_ORDINAL_MONTH value can
   * be used for dates that are part of the same named month in different years.
   * For example, in the Hebrew calendar, "1 Nisan 5781" is associated with
   * UCAL_ORDINAL_MONTH value 6 while "1 Nisan 5782" is associated with
   * UCAL_ORDINAL_MONTH value 7 because 5782 is a leap year and Nisan follows
   * the insertion of Adar I. In Chinese calendar, "Year 4664 Month 6 Day 2"
   * is associated with UCAL_ORDINAL_MONTH value 5 while "Year 4665 Month 6 Day 2"
   * is associated with UCAL_ORDINAL_MONTH value 6 because 4665 is a leap year
   * and there is an extra "Leap Month 5" which associated with UCAL_ORDINAL_MONTH
   * value 5 before "Month 6" of year 4664.
   *
   * @stable ICU 73
   */
  UCAL_ORDINAL_MONTH,

    /* Do not conditionalize the following with #ifndef U_HIDE_DEPRECATED_API,
     * it is needed for layout of Calendar, DateFormat, and other objects */
#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UCalendarDateFields value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UCAL_FIELD_COUNT = UCAL_ORDINAL_MONTH + 1,

#endif  // U_FORCE_HIDE_DEPRECATED_API

 /**
   * Field number indicating the
   * day of the month. This is a synonym for <code>UCAL_DATE</code>.
   * The first day of the month has value 1.
   * @see #UCAL_DATE
   * Synonym for UCAL_DATE
   * @stable ICU 2.8
   **/
  UCAL_DAY_OF_MONTH=UCAL_DATE
};

/** @stable ICU 2.0 */
typedef enum UCalendarDateFields UCalendarDateFields;
    /**
     * Useful constant for days of week. Note: Calendar day-of-week is 1-based. Clients
     * who create locale resources for the field of first-day-of-week should be aware of
     * this. For instance, in US locale, first-day-of-week is set to 1, i.e., UCAL_SUNDAY.
     */
/** Possible days of the week in a UCalendar 
 * @stable ICU 2.0
 */
enum UCalendarDaysOfWeek {
  /** Sunday */
  UCAL_SUNDAY = 1,
  /** Monday */
  UCAL_MONDAY,
  /** Tuesday */
  UCAL_TUESDAY,
  /** Wednesday */
  UCAL_WEDNESDAY,
  /** Thursday */
  UCAL_THURSDAY,
  /** Friday */
  UCAL_FRIDAY,
  /** Saturday */
  UCAL_SATURDAY
};

/** @stable ICU 2.0 */
typedef enum UCalendarDaysOfWeek UCalendarDaysOfWeek;

/** Possible months in a UCalendar. Note: Calendar month is 0-based.
 * @stable ICU 2.0
 */
enum UCalendarMonths {
  /** January */
  UCAL_JANUARY,
  /** February */
  UCAL_FEBRUARY,
  /** March */
  UCAL_MARCH,
  /** April */
  UCAL_APRIL,
  /** May */
  UCAL_MAY,
  /** June */
  UCAL_JUNE,
  /** July */
  UCAL_JULY,
  /** August */
  UCAL_AUGUST,
  /** September */
  UCAL_SEPTEMBER,
  /** October */
  UCAL_OCTOBER,
  /** November */
  UCAL_NOVEMBER,
  /** December */
  UCAL_DECEMBER,
  /** Value of the <code>UCAL_MONTH</code> field indicating the
    * thirteenth month of the year. Although the Gregorian calendar
    * does not use this value, lunar calendars do.
    */
  UCAL_UNDECIMBER
};

/** @stable ICU 2.0 */
typedef enum UCalendarMonths UCalendarMonths;

/** Possible AM/PM values in a UCalendar 
 * @stable ICU 2.0
 */
enum UCalendarAMPMs {
    /** AM */
  UCAL_AM,
  /** PM */
  UCAL_PM
};

/** @stable ICU 2.0 */
typedef enum UCalendarAMPMs UCalendarAMPMs;

/**
 * System time zone type constants used by filtering zones
 * in ucal_openTimeZoneIDEnumeration.
 * @see ucal_openTimeZoneIDEnumeration
 * @stable ICU 4.8
 */
enum USystemTimeZoneType {
    /**
     * Any system zones.
     * @stable ICU 4.8
     */
    UCAL_ZONE_TYPE_ANY,
    /**
     * Canonical system zones.
     * @stable ICU 4.8
     */
    UCAL_ZONE_TYPE_CANONICAL,
    /**
     * Canonical system zones associated with actual locations.
     * @stable ICU 4.8
     */
    UCAL_ZONE_TYPE_CANONICAL_LOCATION
};

/** @stable ICU 4.8 */
typedef enum USystemTimeZoneType USystemTimeZoneType;

/** 
 * Create an enumeration over system time zone IDs with the given
 * filter conditions. 
 * @param zoneType  The system time zone type.
 * @param region    The ISO 3166 two-letter country code or UN M.49
 *                  three-digit area code.  When NULL, no filtering
 *                  done by region. 
 * @param rawOffset An offset from GMT in milliseconds, ignoring the
 *                  effect of daylight savings time, if any. When NULL,
 *                  no filtering done by zone offset.
 * @param ec        A pointer to an UErrorCode to receive any errors
 * @return  an enumeration object that the caller must dispose of
 *          using enum_close(), or NULL upon failure. In case of failure,
 *          *ec will indicate the error.
 * @stable ICU 4.8
 */ 
U_CAPI UEnumeration* U_EXPORT2
ucal_openTimeZoneIDEnumeration(USystemTimeZoneType zoneType, const char* region,
                                const int32_t* rawOffset, UErrorCode* ec);

/**
 * Create an enumeration over all time zones.
 *
 * @param ec input/output error code
 *
 * @return an enumeration object that the caller must dispose of using
 * uenum_close(), or NULL upon failure. In case of failure *ec will
 * indicate the error.
 *
 * @stable ICU 2.6
 */
U_CAPI UEnumeration* U_EXPORT2
ucal_openTimeZones(UErrorCode* ec);

/**
 * Create an enumeration over all time zones associated with the given
 * country. Some zones are affiliated with no country (e.g., "UTC");
 * these may also be retrieved, as a group.
 *
 * @param country the ISO 3166 two-letter country code, or NULL to
 * retrieve zones not affiliated with any country
 *
 * @param ec input/output error code
 *
 * @return an enumeration object that the caller must dispose of using
 * uenum_close(), or NULL upon failure. In case of failure *ec will
 * indicate the error.
 *
 * @stable ICU 2.6
 */
U_CAPI UEnumeration* U_EXPORT2
ucal_openCountryTimeZones(const char* country, UErrorCode* ec);

/**
 * Return the default time zone. The default is determined initially
 * by querying the host operating system. If the host system detection
 * routines fail, or if they specify a TimeZone or TimeZone offset
 * which is not recognized, then the special TimeZone "Etc/Unknown"
 * is returned.
 * 
 * The default may be changed with `ucal_setDefaultTimeZone()` or with
 * the C++ TimeZone API, `TimeZone::adoptDefault(TimeZone*)`.
 *
 * @param result A buffer to receive the result, or NULL
 *
 * @param resultCapacity The capacity of the result buffer
 *
 * @param ec input/output error code
 *
 * @return The result string length, not including the terminating
 * null
 * 
 * @see #UCAL_UNKNOWN_ZONE_ID
 * 
 * @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2
ucal_getDefaultTimeZone(UChar* result, int32_t resultCapacity, UErrorCode* ec);

/**
 * Set the default time zone.
 *
 * @param zoneID null-terminated time zone ID
 *
 * @param ec input/output error code
 *
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
ucal_setDefaultTimeZone(const UChar* zoneID, UErrorCode* ec);

/**
 * Return the current host time zone. The host time zone is detected from
 * the current host system configuration by querying the host operating
 * system. If the host system detection routines fail, or if they specify
 * a TimeZone or TimeZone offset which is not recognized, then the special
 * TimeZone "Etc/Unknown" is returned.
 * 
 * Note that host time zone and the ICU default time zone can be different.
 * 
 * The ICU default time zone does not change once initialized unless modified
 * by calling `ucal_setDefaultTimeZone()` or with the C++ TimeZone API,
 * `TimeZone::adoptDefault(TimeZone*)`.
 * 
 * If the host operating system configuration has changed since ICU has
 * initialized then the returned value can be different than the ICU default
 * time zone, even if the default has not changed.
 *
 * <p>This function is not thread safe.</p>
 * 
 * @param result A buffer to receive the result, or NULL
 * @param resultCapacity The capacity of the result buffer
 * @param ec input/output error code
 * @return The result string length, not including the terminating
 * null
 * 
 * @see #UCAL_UNKNOWN_ZONE_ID
 * 
 * @stable ICU 65
 */
U_CAPI int32_t U_EXPORT2
ucal_getHostTimeZone(UChar *result, int32_t resultCapacity, UErrorCode *ec);

/**
 * Return the amount of time in milliseconds that the clock is
 * advanced during daylight savings time for the given time zone, or
 * zero if the time zone does not observe daylight savings time.
 *
 * @param zoneID null-terminated time zone ID
 *
 * @param ec input/output error code
 *
 * @return the number of milliseconds the time is advanced with
 * respect to standard time when the daylight savings rules are in
 * effect. This is always a non-negative number, most commonly either
 * 3,600,000 (one hour) or zero.
 *
 * @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2
ucal_getDSTSavings(const UChar* zoneID, UErrorCode* ec);

/**
 * Get the current date and time.
 * The value returned is represented as milliseconds from the epoch.
 * @return The current date and time.
 * @stable ICU 2.0
 */
U_CAPI UDate U_EXPORT2 
ucal_getNow(void);

/**
 * Open a UCalendar.
 * A UCalendar may be used to convert a millisecond value to a year,
 * month, and day.
 * <p>
 * Note: When unknown TimeZone ID is specified or if the TimeZone ID specified is "Etc/Unknown",
 * the UCalendar returned by the function is initialized with GMT zone with TimeZone ID
 * <code>UCAL_UNKNOWN_ZONE_ID</code> ("Etc/Unknown") without any errors/warnings.  If you want
 * to check if a TimeZone ID is valid prior to this function, use <code>ucal_getCanonicalTimeZoneID</code>.
 * 
 * @param zoneID The desired TimeZone ID.  If 0, use the default time zone.
 * @param len The length of zoneID, or -1 if null-terminated.
 * @param locale The desired locale
 * @param type The type of UCalendar to open. This can be UCAL_GREGORIAN to open the Gregorian
 * calendar for the locale, or UCAL_DEFAULT to open the default calendar for the locale (the
 * default calendar may also be Gregorian). To open a specific non-Gregorian calendar for the
 * locale, use uloc_setKeywordValue to set the value of the calendar keyword for the locale
 * and then pass the locale to ucal_open with UCAL_DEFAULT as the type.
 * @param status A pointer to an UErrorCode to receive any errors
 * @return A pointer to a UCalendar, or 0 if an error occurred.
 * @see #UCAL_UNKNOWN_ZONE_ID
 * @stable ICU 2.0
 */
U_CAPI UCalendar* U_EXPORT2 
ucal_open(const UChar*   zoneID,
          int32_t        len,
          const char*    locale,
          UCalendarType  type,
          UErrorCode*    status);

/**
 * Close a UCalendar.
 * Once closed, a UCalendar may no longer be used.
 * @param cal The UCalendar to close.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_close(UCalendar *cal);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUCalendarPointer
 * "Smart pointer" class, closes a UCalendar via ucal_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUCalendarPointer, UCalendar, ucal_close);

U_NAMESPACE_END

#endif

/**
 * Open a copy of a UCalendar.
 * This function performs a deep copy.
 * @param cal The calendar to copy
 * @param status A pointer to an UErrorCode to receive any errors.
 * @return A pointer to a UCalendar identical to cal.
 * @stable ICU 4.0
 */
U_CAPI UCalendar* U_EXPORT2 
ucal_clone(const UCalendar* cal,
           UErrorCode*      status);

/**
 * Set the TimeZone used by a UCalendar.
 * A UCalendar uses a timezone for converting from Greenwich time to local time.
 * @param cal The UCalendar to set.
 * @param zoneID The desired TimeZone ID.  If 0, use the default time zone.
 * @param len The length of zoneID, or -1 if null-terminated.
 * @param status A pointer to an UErrorCode to receive any errors.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_setTimeZone(UCalendar*    cal,
                 const UChar*  zoneID,
                 int32_t       len,
                 UErrorCode*   status);

/** 
 * Get the ID of the UCalendar's time zone. 
 * 
 * @param cal           The UCalendar to query. 
 * @param result        Receives the UCalendar's time zone ID. 
 * @param resultLength  The maximum size of result. 
 * @param status        Receives the status. 
 * @return              The total buffer size needed; if greater than resultLength, the output was truncated. 
 * @stable ICU 51 
 */ 
U_CAPI int32_t U_EXPORT2 
ucal_getTimeZoneID(const UCalendar *cal,
                   UChar *result,
                   int32_t resultLength,
                   UErrorCode *status);

/**
 * Possible formats for a UCalendar's display name 
 * @stable ICU 2.0
 */
enum UCalendarDisplayNameType {
  /** Standard display name */
  UCAL_STANDARD,
  /** Short standard display name */
  UCAL_SHORT_STANDARD,
  /** Daylight savings display name */
  UCAL_DST,
  /** Short daylight savings display name */
  UCAL_SHORT_DST
};

/** @stable ICU 2.0 */
typedef enum UCalendarDisplayNameType UCalendarDisplayNameType;

/**
 * Get the display name for a UCalendar's TimeZone.
 * A display name is suitable for presentation to a user.
 * @param cal          The UCalendar to query.
 * @param type         The desired display name format; one of UCAL_STANDARD, UCAL_SHORT_STANDARD,
 *                     UCAL_DST, UCAL_SHORT_DST
 * @param locale       The desired locale for the display name.
 * @param result       A pointer to a buffer to receive the formatted number.
 * @param resultLength The maximum size of result.
 * @param status       A pointer to an UErrorCode to receive any errors
 * @return             The total buffer size needed; if greater than resultLength, the output was truncated.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucal_getTimeZoneDisplayName(const UCalendar*          cal,
                            UCalendarDisplayNameType  type,
                            const char*               locale,
                            UChar*                    result,
                            int32_t                   resultLength,
                            UErrorCode*               status);

/**
 * Determine if a UCalendar is currently in daylight savings time.
 * Daylight savings time is not used in all parts of the world.
 * @param cal The UCalendar to query.
 * @param status A pointer to an UErrorCode to receive any errors
 * @return true if cal is currently in daylight savings time, false otherwise
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucal_inDaylightTime(const UCalendar*  cal,
                    UErrorCode*       status );

/**
 * Sets the GregorianCalendar change date. This is the point when the switch from
 * Julian dates to Gregorian dates occurred. Default is 00:00:00 local time, October
 * 15, 1582. Previous to this time and date will be Julian dates.
 *
 * This function works only for Gregorian calendars. If the UCalendar is not
 * an instance of a Gregorian calendar, then a U_UNSUPPORTED_ERROR
 * error code is set.
 *
 * @param cal        The calendar object.
 * @param date       The given Gregorian cutover date.
 * @param pErrorCode Pointer to a standard ICU error code. Its input value must
 *                   pass the U_SUCCESS() test, or else the function returns
 *                   immediately. Check for U_FAILURE() on output or use with
 *                   function chaining. (See User Guide for details.)
 *
 * @see GregorianCalendar::setGregorianChange
 * @see ucal_getGregorianChange
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ucal_setGregorianChange(UCalendar *cal, UDate date, UErrorCode *pErrorCode);

/**
 * Gets the Gregorian Calendar change date. This is the point when the switch from
 * Julian dates to Gregorian dates occurred. Default is 00:00:00 local time, October
 * 15, 1582. Previous to this time and date will be Julian dates.
 *
 * This function works only for Gregorian calendars. If the UCalendar is not
 * an instance of a Gregorian calendar, then a U_UNSUPPORTED_ERROR
 * error code is set.
 *
 * @param cal        The calendar object.
 * @param pErrorCode Pointer to a standard ICU error code. Its input value must
 *                   pass the U_SUCCESS() test, or else the function returns
 *                   immediately. Check for U_FAILURE() on output or use with
 *                   function chaining. (See User Guide for details.)
 * @return   The Gregorian cutover time for this calendar.
 *
 * @see GregorianCalendar::getGregorianChange
 * @see ucal_setGregorianChange
 * @stable ICU 3.6
 */
U_CAPI UDate U_EXPORT2
ucal_getGregorianChange(const UCalendar *cal, UErrorCode *pErrorCode);

/**
 * Types of UCalendar attributes 
 * @stable ICU 2.0
 */
enum UCalendarAttribute {
  /**
   * Lenient parsing
   * @stable ICU 2.0
   */
  UCAL_LENIENT,
  /**
   * First day of week
   * @stable ICU 2.0
   */
  UCAL_FIRST_DAY_OF_WEEK,
  /**
   * Minimum number of days in first week
   * @stable ICU 2.0
   */
  UCAL_MINIMAL_DAYS_IN_FIRST_WEEK,
  /**
   * The behavior for handling wall time repeating multiple times
   * at negative time zone offset transitions
   * @stable ICU 49
   */
  UCAL_REPEATED_WALL_TIME,
  /**
   * The behavior for handling skipped wall time at positive time
   * zone offset transitions.
   * @stable ICU 49
   */
  UCAL_SKIPPED_WALL_TIME
};

/** @stable ICU 2.0 */
typedef enum UCalendarAttribute UCalendarAttribute;

/**
 * Options for handling ambiguous wall time at time zone
 * offset transitions.
 * @stable ICU 49
 */
enum UCalendarWallTimeOption {
    /**
     * An ambiguous wall time to be interpreted as the latest.
     * This option is valid for UCAL_REPEATED_WALL_TIME and
     * UCAL_SKIPPED_WALL_TIME.
     * @stable ICU 49
     */
    UCAL_WALLTIME_LAST,
    /**
     * An ambiguous wall time to be interpreted as the earliest.
     * This option is valid for UCAL_REPEATED_WALL_TIME and
     * UCAL_SKIPPED_WALL_TIME.
     * @stable ICU 49
     */
    UCAL_WALLTIME_FIRST,
    /**
     * An ambiguous wall time to be interpreted as the next valid
     * wall time. This option is valid for UCAL_SKIPPED_WALL_TIME.
     * @stable ICU 49
     */
    UCAL_WALLTIME_NEXT_VALID
};
/** @stable ICU 49 */
typedef enum UCalendarWallTimeOption UCalendarWallTimeOption;

/**
 * Get a numeric attribute associated with a UCalendar.
 * Numeric attributes include the first day of the week, or the minimal numbers
 * of days in the first week of the month.
 * @param cal The UCalendar to query.
 * @param attr The desired attribute; one of UCAL_LENIENT, UCAL_FIRST_DAY_OF_WEEK,
 * UCAL_MINIMAL_DAYS_IN_FIRST_WEEK, UCAL_REPEATED_WALL_TIME or UCAL_SKIPPED_WALL_TIME
 * @return The value of attr.
 * @see ucal_setAttribute
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucal_getAttribute(const UCalendar*    cal,
                  UCalendarAttribute  attr);

/**
 * Set a numeric attribute associated with a UCalendar.
 * Numeric attributes include the first day of the week, or the minimal numbers
 * of days in the first week of the month.
 * @param cal The UCalendar to set.
 * @param attr The desired attribute; one of UCAL_LENIENT, UCAL_FIRST_DAY_OF_WEEK,
 * UCAL_MINIMAL_DAYS_IN_FIRST_WEEK, UCAL_REPEATED_WALL_TIME or UCAL_SKIPPED_WALL_TIME
 * @param newValue The new value of attr.
 * @see ucal_getAttribute
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_setAttribute(UCalendar*          cal,
                  UCalendarAttribute  attr,
                  int32_t             newValue);

/**
 * Get a locale for which calendars are available.
 * A UCalendar in a locale returned by this function will contain the correct
 * day and month names for the locale.
 * @param localeIndex The index of the desired locale.
 * @return A locale for which calendars are available, or 0 if none.
 * @see ucal_countAvailable
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2 
ucal_getAvailable(int32_t localeIndex);

/**
 * Determine how many locales have calendars available.
 * This function is most useful as determining the loop ending condition for
 * calls to \ref ucal_getAvailable.
 * @return The number of locales for which calendars are available.
 * @see ucal_getAvailable
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucal_countAvailable(void);

/**
 * Get a UCalendar's current time in millis.
 * The time is represented as milliseconds from the epoch.
 * @param cal The UCalendar to query.
 * @param status A pointer to an UErrorCode to receive any errors
 * @return The calendar's current time in millis.
 * @see ucal_setMillis
 * @see ucal_setDate
 * @see ucal_setDateTime
 * @stable ICU 2.0
 */
U_CAPI UDate U_EXPORT2 
ucal_getMillis(const UCalendar*  cal,
               UErrorCode*       status);

/**
 * Set a UCalendar's current time in millis.
 * The time is represented as milliseconds from the epoch.
 * @param cal The UCalendar to set.
 * @param dateTime The desired date and time.
 * @param status A pointer to an UErrorCode to receive any errors
 * @see ucal_getMillis
 * @see ucal_setDate
 * @see ucal_setDateTime
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_setMillis(UCalendar*   cal,
               UDate        dateTime,
               UErrorCode*  status );

/**
 * Set a UCalendar's current date.
 * The date is represented as a series of 32-bit integers.
 * @param cal The UCalendar to set.
 * @param year The desired year.
 * @param month The desired month; one of UCAL_JANUARY, UCAL_FEBRUARY, UCAL_MARCH, UCAL_APRIL, UCAL_MAY,
 * UCAL_JUNE, UCAL_JULY, UCAL_AUGUST, UCAL_SEPTEMBER, UCAL_OCTOBER, UCAL_NOVEMBER, UCAL_DECEMBER, UCAL_UNDECIMBER
 * @param date The desired day of the month.
 * @param status A pointer to an UErrorCode to receive any errors
 * @see ucal_getMillis
 * @see ucal_setMillis
 * @see ucal_setDateTime
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_setDate(UCalendar*   cal,
             int32_t      year,
             int32_t      month,
             int32_t      date,
             UErrorCode*  status);

/**
 * Set a UCalendar's current date.
 * The date is represented as a series of 32-bit integers.
 * @param cal The UCalendar to set.
 * @param year The desired year.
 * @param month The desired month; one of UCAL_JANUARY, UCAL_FEBRUARY, UCAL_MARCH, UCAL_APRIL, UCAL_MAY,
 * UCAL_JUNE, UCAL_JULY, UCAL_AUGUST, UCAL_SEPTEMBER, UCAL_OCTOBER, UCAL_NOVEMBER, UCAL_DECEMBER, UCAL_UNDECIMBER
 * @param date The desired day of the month.
 * @param hour The desired hour of day.
 * @param minute The desired minute.
 * @param second The desirec second.
 * @param status A pointer to an UErrorCode to receive any errors
 * @see ucal_getMillis
 * @see ucal_setMillis
 * @see ucal_setDate
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_setDateTime(UCalendar*   cal,
                 int32_t      year,
                 int32_t      month,
                 int32_t      date,
                 int32_t      hour,
                 int32_t      minute,
                 int32_t      second,
                 UErrorCode*  status);

/**
 * Returns true if two UCalendars are equivalent.  Equivalent
 * UCalendars will behave identically, but they may be set to
 * different times.
 * @param cal1 The first of the UCalendars to compare.
 * @param cal2 The second of the UCalendars to compare.
 * @return true if cal1 and cal2 are equivalent, false otherwise.
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucal_equivalentTo(const UCalendar*  cal1,
                  const UCalendar*  cal2);

/**
 * Add a specified signed amount to a particular field in a UCalendar.
 * This can modify more significant fields in the calendar.
 * Adding a positive value always means moving forward in time, so for the Gregorian calendar,
 * starting with 100 BC and adding +1 to year results in 99 BC (even though this actually reduces
 * the numeric value of the field itself).
 * @param cal The UCalendar to which to add.
 * @param field The field to which to add the signed value; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param amount The signed amount to add to field. If the amount causes the value
 * to exceed to maximum or minimum values for that field, other fields are modified
 * to preserve the magnitude of the change.
 * @param status A pointer to an UErrorCode to receive any errors
 * @see ucal_roll
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_add(UCalendar*           cal,
         UCalendarDateFields  field,
         int32_t              amount,
         UErrorCode*          status);

/**
 * Add a specified signed amount to a particular field in a UCalendar.
 * This will not modify more significant fields in the calendar.
 * Rolling by a positive value always means moving forward in time (unless the limit of the
 * field is reached, in which case it may pin or wrap), so for Gregorian calendar,
 * starting with 100 BC and rolling the year by +1 results in 99 BC.
 * When eras have a definite beginning and end (as in the Chinese calendar, or as in most eras in the
 * Japanese calendar) then rolling the year past either limit of the era will cause the year to wrap around.
 * When eras only have a limit at one end, then attempting to roll the year past that limit will result in
 * pinning the year at that limit. Note that for most calendars in which era 0 years move forward in time
 * (such as Buddhist, Hebrew, or Islamic), it is possible for add or roll to result in negative years for
 * era 0 (that is the only way to represent years before the calendar epoch).
 * @param cal The UCalendar to which to add.
 * @param field The field to which to add the signed value; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param amount The signed amount to add to field. If the amount causes the value
 * to exceed to maximum or minimum values for that field, the field is pinned to a permissible
 * value.
 * @param status A pointer to an UErrorCode to receive any errors
 * @see ucal_add
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_roll(UCalendar*           cal,
          UCalendarDateFields  field,
          int32_t              amount,
          UErrorCode*          status);

/**
 * Get the current value of a field from a UCalendar.
 * All fields are represented as 32-bit integers.
 * @param cal The UCalendar to query.
 * @param field The desired field; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param status A pointer to an UErrorCode to receive any errors
 * @return The value of the desired field.
 * @see ucal_set
 * @see ucal_isSet
 * @see ucal_clearField
 * @see ucal_clear
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucal_get(const UCalendar*     cal,
         UCalendarDateFields  field,
         UErrorCode*          status );

/**
 * Set the value of a field in a UCalendar.
 * All fields are represented as 32-bit integers.
 * @param cal The UCalendar to set.
 * @param field The field to set; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param value The desired value of field.
 * @see ucal_get
 * @see ucal_isSet
 * @see ucal_clearField
 * @see ucal_clear
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_set(UCalendar*           cal,
         UCalendarDateFields  field,
         int32_t              value);

/**
 * Determine if a field in a UCalendar is set.
 * All fields are represented as 32-bit integers.
 * @param cal The UCalendar to query.
 * @param field The desired field; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @return true if field is set, false otherwise.
 * @see ucal_get
 * @see ucal_set
 * @see ucal_clearField
 * @see ucal_clear
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2 
ucal_isSet(const UCalendar*     cal,
           UCalendarDateFields  field);

/**
 * Clear a field in a UCalendar.
 * All fields are represented as 32-bit integers.
 * @param cal The UCalendar containing the field to clear.
 * @param field The field to clear; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @see ucal_get
 * @see ucal_set
 * @see ucal_isSet
 * @see ucal_clear
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_clearField(UCalendar*           cal,
                UCalendarDateFields  field);

/**
 * Clear all fields in a UCalendar.
 * All fields are represented as 32-bit integers.
 * @param calendar The UCalendar to clear.
 * @see ucal_get
 * @see ucal_set
 * @see ucal_isSet
 * @see ucal_clearField
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
ucal_clear(UCalendar* calendar);

/**
 * Possible limit values for a UCalendar 
 * @stable ICU 2.0
 */
enum UCalendarLimitType {
  /** Minimum value */
  UCAL_MINIMUM,
  /** Maximum value */
  UCAL_MAXIMUM,
  /** Greatest minimum value */
  UCAL_GREATEST_MINIMUM,
  /** Least maximum value */
  UCAL_LEAST_MAXIMUM,
  /** Actual minimum value */
  UCAL_ACTUAL_MINIMUM,
  /** Actual maximum value */
  UCAL_ACTUAL_MAXIMUM
};

/** @stable ICU 2.0 */
typedef enum UCalendarLimitType UCalendarLimitType;

/**
 * Determine a limit for a field in a UCalendar.
 * A limit is a maximum or minimum value for a field.
 * @param cal The UCalendar to query.
 * @param field The desired field; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param type The desired critical point; one of UCAL_MINIMUM, UCAL_MAXIMUM, UCAL_GREATEST_MINIMUM,
 * UCAL_LEAST_MAXIMUM, UCAL_ACTUAL_MINIMUM, UCAL_ACTUAL_MAXIMUM
 * @param status A pointer to an UErrorCode to receive any errors.
 * @return The requested value.
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
ucal_getLimit(const UCalendar*     cal,
              UCalendarDateFields  field,
              UCalendarLimitType   type,
              UErrorCode*          status);

/** Get the locale for this calendar object. You can choose between valid and actual locale.
 *  @param cal The calendar object
 *  @param type type of the locale we're looking for (valid or actual) 
 *  @param status error code for the operation
 *  @return the locale name
 *  @stable ICU 2.8
 */
U_CAPI const char * U_EXPORT2
ucal_getLocaleByType(const UCalendar *cal, ULocDataLocaleType type, UErrorCode* status);

/**
 * Returns the timezone data version currently used by ICU.
 * @param status error code for the operation
 * @return the version string, such as "2007f"
 * @stable ICU 3.8
 */
U_CAPI const char * U_EXPORT2
ucal_getTZDataVersion(UErrorCode* status);

/**
 * Returns the canonical system timezone ID or the normalized
 * custom time zone ID for the given time zone ID.
 * @param id        The input timezone ID to be canonicalized.
 * @param len       The length of id, or -1 if null-terminated.
 * @param result    The buffer receives the canonical system timezone ID
 *                  or the custom timezone ID in normalized format.
 * @param resultCapacity    The capacity of the result buffer.
 * @param isSystemID        Receives if the given ID is a known system
     *                      timezone ID.
 * @param status    Receives the status.  When the given timezone ID
 *                  is neither a known system time zone ID nor a
 *                  valid custom timezone ID, U_ILLEGAL_ARGUMENT_ERROR
 *                  is set.
 * @return          The result string length, not including the terminating
 *                  null.
 * @stable ICU 4.0
 */
U_CAPI int32_t U_EXPORT2
ucal_getCanonicalTimeZoneID(const UChar* id, int32_t len,
                            UChar* result, int32_t resultCapacity, UBool *isSystemID, UErrorCode* status);

/**
 * Returns the preferred time zone ID in the IANA time zone database for the given time zone ID.
 * There are two types of preferred IDs. The first type is the one defined in zone.tab file,
 * such as "America/Los_Angeles". The second types is the one defined for zones not associated
 * with a specific region, but not defined with "Link" syntax such as "Etc/GMT+10".
 *
 * <p>Note: For most of valid time zone IDs, this method returns an ID same as ucal_getCanonicalTimeZoneID().
 * ucal_getCanonicalTimeZoneID() is based on canonical time zone IDs defined in Unicode CLDR.
 * These canonical time zone IDs in CLDR were based on very old version of the time zone database.
 * In the IANA time zone database, some IDs were updated since then. This API returns a newer
 * time zone ID. For example, CLDR defines "Asia/Calcutta" as the canonical time zone ID. This
 * method returns "Asia/Kolkata" instead.
 * <p> "Etc/Unknown" is a special time zone ID defined by CLDR. There are no corresponding zones
 * in the IANA time zone database. Therefore, this API returns U_ILLEGAL_ARGUMENT_ERROR when the
 * input ID is "Etc/Unknown".
 *
 * @param id        The input time zone ID.
 * @param len       The length of the input time zone ID.
 * @param result    The buffer receives the preferred time zone ID in the IANA time zone database.
 * @param resultCapacity  The capacity of the result buffer.
 * @param status    Receives the status.  When the given time zone ID is not a known system time zone
 *                  ID, U_ILLEGAL_ARGUMENT_ERROR is set.
 * @return          The result string length, not including the terminating null.
 * @stable ICU 74
 */
U_CAPI int32_t U_EXPORT2
ucal_getIanaTimeZoneID(const UChar* id, int32_t len,
                        UChar* result, int32_t resultCapacity, UErrorCode* status);

/**
 * Get the resource keyword value string designating the calendar type for the UCalendar.
 * @param cal The UCalendar to query.
 * @param status The error code for the operation.
 * @return The resource keyword value string.
 * @stable ICU 4.2
 */
U_CAPI const char * U_EXPORT2
ucal_getType(const UCalendar *cal, UErrorCode* status);

/**
 * Given a key and a locale, returns an array of string values in a preferred
 * order that would make a difference. These are all and only those values where
 * the open (creation) of the service with the locale formed from the input locale
 * plus input keyword and that value has different behavior than creation with the
 * input locale alone.
 * @param key           one of the keys supported by this service.  For now, only
 *                      "calendar" is supported.
 * @param locale        the locale
 * @param commonlyUsed  if set to true it will return only commonly used values
 *                      with the given locale in preferred order.  Otherwise,
 *                      it will return all the available values for the locale.
 * @param status error status
 * @return a string enumeration over keyword values for the given key and the locale.
 * @stable ICU 4.2
 */
U_CAPI UEnumeration* U_EXPORT2
ucal_getKeywordValuesForLocale(const char* key,
                               const char* locale,
                               UBool commonlyUsed,
                               UErrorCode* status);


/** Weekday types, as returned by ucal_getDayOfWeekType().
 * @stable ICU 4.4
 */
enum UCalendarWeekdayType {
  /**
   * Designates a full weekday (no part of the day is included in the weekend).
   * @stable ICU 4.4 
   */
  UCAL_WEEKDAY,
  /**
   * Designates a full weekend day (the entire day is included in the weekend).
   * @stable ICU 4.4 
   */
  UCAL_WEEKEND,
  /**
   * Designates a day that starts as a weekday and transitions to the weekend.
   * Call ucal_getWeekendTransition() to get the time of transition.
   * @stable ICU 4.4 
   */
  UCAL_WEEKEND_ONSET,
  /**
   * Designates a day that starts as the weekend and transitions to a weekday.
   * Call ucal_getWeekendTransition() to get the time of transition.
   * @stable ICU 4.4 
   */
  UCAL_WEEKEND_CEASE
};

/** @stable ICU 4.4 */
typedef enum UCalendarWeekdayType UCalendarWeekdayType;

/**
 * Returns whether the given day of the week is a weekday, a weekend day,
 * or a day that transitions from one to the other, for the locale and
 * calendar system associated with this UCalendar (the locale's region is
 * often the most determinant factor). If a transition occurs at midnight,
 * then the days before and after the transition will have the
 * type UCAL_WEEKDAY or UCAL_WEEKEND. If a transition occurs at a time
 * other than midnight, then the day of the transition will have
 * the type UCAL_WEEKEND_ONSET or UCAL_WEEKEND_CEASE. In this case, the
 * function ucal_getWeekendTransition() will return the point of
 * transition.
 * @param cal The UCalendar to query.
 * @param dayOfWeek The day of the week whose type is desired (UCAL_SUNDAY..UCAL_SATURDAY).
 * @param status The error code for the operation.
 * @return The UCalendarWeekdayType for the day of the week.
 * @stable ICU 4.4
 */
U_CAPI UCalendarWeekdayType U_EXPORT2
ucal_getDayOfWeekType(const UCalendar *cal, UCalendarDaysOfWeek dayOfWeek, UErrorCode* status);

/**
 * Returns the time during the day at which the weekend begins or ends in
 * this calendar system.  If ucal_getDayOfWeekType() returns UCAL_WEEKEND_ONSET
 * for the specified dayOfWeek, return the time at which the weekend begins.
 * If ucal_getDayOfWeekType() returns UCAL_WEEKEND_CEASE for the specified dayOfWeek,
 * return the time at which the weekend ends. If ucal_getDayOfWeekType() returns
 * some other UCalendarWeekdayType for the specified dayOfWeek, is it an error condition
 * (U_ILLEGAL_ARGUMENT_ERROR).
 * @param cal The UCalendar to query.
 * @param dayOfWeek The day of the week for which the weekend transition time is
 * desired (UCAL_SUNDAY..UCAL_SATURDAY).
 * @param status The error code for the operation.
 * @return The milliseconds after midnight at which the weekend begins or ends.
 * @stable ICU 4.4
 */
U_CAPI int32_t U_EXPORT2
ucal_getWeekendTransition(const UCalendar *cal, UCalendarDaysOfWeek dayOfWeek, UErrorCode *status);

/**
 * Returns true if the given UDate is in the weekend in
 * this calendar system.
 * @param cal The UCalendar to query.
 * @param date The UDate in question.
 * @param status The error code for the operation.
 * @return true if the given UDate is in the weekend in
 * this calendar system, false otherwise.
 * @stable ICU 4.4
 */
U_CAPI UBool U_EXPORT2
ucal_isWeekend(const UCalendar *cal, UDate date, UErrorCode *status);

/**
 * Return the difference between the target time and the time this calendar object is currently set to.
 * If the target time is after the current calendar setting, the returned value will be positive.
 * The field parameter specifies the units of the return value. For example, if field is UCAL_MONTH
 * and ucal_getFieldDifference returns 3, then the target time is 3 to less than 4 months after the
 * current calendar setting.
 *
 * As a side effect of this call, this calendar is advanced toward target by the given amount. That is,
 * calling this function has the side effect of calling ucal_add on this calendar with the specified
 * field and an amount equal to the return value from this function.
 *
 * A typical way of using this function is to call it first with the largest field of interest, then
 * with progressively smaller fields.
 * 
 * @param cal The UCalendar to compare and update.
 * @param target The target date to compare to the current calendar setting.
 * @param field The field to compare; one of UCAL_ERA, UCAL_YEAR, UCAL_MONTH,
 * UCAL_WEEK_OF_YEAR, UCAL_WEEK_OF_MONTH, UCAL_DATE, UCAL_DAY_OF_YEAR, UCAL_DAY_OF_WEEK,
 * UCAL_DAY_OF_WEEK_IN_MONTH, UCAL_AM_PM, UCAL_HOUR, UCAL_HOUR_OF_DAY, UCAL_MINUTE, UCAL_SECOND,
 * UCAL_MILLISECOND, UCAL_ZONE_OFFSET, UCAL_DST_OFFSET.
 * @param status A pointer to an UErrorCode to receive any errors
 * @return The date difference for the specified field.
 * @stable ICU 4.8
 */
U_CAPI int32_t U_EXPORT2 
ucal_getFieldDifference(UCalendar* cal,
                        UDate target,
                        UCalendarDateFields field,
                        UErrorCode* status);

/**
 * Time zone transition types for ucal_getTimeZoneTransitionDate
 * @stable ICU 50
 */
enum UTimeZoneTransitionType {
    /**
     * Get the next transition after the current date,
     * i.e. excludes the current date
     * @stable ICU 50
     */
    UCAL_TZ_TRANSITION_NEXT,
    /**
     * Get the next transition on or after the current date,
     * i.e. may include the current date
     * @stable ICU 50
     */
    UCAL_TZ_TRANSITION_NEXT_INCLUSIVE,
    /**
     * Get the previous transition before the current date,
     * i.e. excludes the current date
     * @stable ICU 50
     */
    UCAL_TZ_TRANSITION_PREVIOUS,
    /**
     * Get the previous transition on or before the current date,
     * i.e. may include the current date
     * @stable ICU 50
     */
    UCAL_TZ_TRANSITION_PREVIOUS_INCLUSIVE
};

typedef enum UTimeZoneTransitionType UTimeZoneTransitionType; /**< @stable ICU 50 */

/**
* Get the UDate for the next/previous time zone transition relative to
* the calendar's current date, in the time zone to which the calendar
* is currently set. If there is no known time zone transition of the
* requested type relative to the calendar's date, the function returns
* false.
* @param cal The UCalendar to query.
* @param type The type of transition desired.
* @param transition A pointer to a UDate to be set to the transition time.
*         If the function returns false, the value set is unspecified.
* @param status A pointer to a UErrorCode to receive any errors.
* @return true if a valid transition time is set in *transition, false
*         otherwise.
* @stable ICU 50
*/
U_CAPI UBool U_EXPORT2 
ucal_getTimeZoneTransitionDate(const UCalendar* cal, UTimeZoneTransitionType type,
                               UDate* transition, UErrorCode* status);

/**
* Converts a system time zone ID to an equivalent Windows time zone ID. For example,
* Windows time zone ID "Pacific Standard Time" is returned for input "America/Los_Angeles".
*
* <p>There are system time zones that cannot be mapped to Windows zones. When the input
* system time zone ID is unknown or unmappable to a Windows time zone, then this
* function returns 0 as the result length, but the operation itself remains successful
* (no error status set on return).
*
* <p>This implementation utilizes <a href="http://unicode.org/cldr/charts/supplemental/zone_tzid.html">
* Zone-Tzid mapping data</a>. The mapping data is updated time to time. To get the latest changes,
* please read the ICU user guide section <a href="https://unicode-org.github.io/icu/userguide/datetime/timezone#updating-the-time-zone-data">
* Updating the Time Zone Data</a>.
*
* @param id            A system time zone ID.
* @param len           The length of <code>id</code>, or -1 if null-terminated.
* @param winid         A buffer to receive a Windows time zone ID.
* @param winidCapacity The capacity of the result buffer <code>winid</code>.
* @param status        Receives the status.
* @return              The result string length, not including the terminating null.
* @see ucal_getTimeZoneIDForWindowsID
*
* @stable ICU 52
*/
U_CAPI int32_t U_EXPORT2
ucal_getWindowsTimeZoneID(const UChar* id, int32_t len,
                            UChar* winid, int32_t winidCapacity, UErrorCode* status);

/**
* Converts a Windows time zone ID to an equivalent system time zone ID
* for a region. For example, system time zone ID "America/Los_Angeles" is returned
* for input Windows ID "Pacific Standard Time" and region "US" (or <code>null</code>),
* "America/Vancouver" is returned for the same Windows ID "Pacific Standard Time" and
* region "CA".
*
* <p>Not all Windows time zones can be mapped to system time zones. When the input
* Windows time zone ID is unknown or unmappable to a system time zone, then this
* function returns 0 as the result length, but the operation itself remains successful
* (no error status set on return).
*
* <p>This implementation utilizes <a href="http://unicode.org/cldr/charts/supplemental/zone_tzid.html">
* Zone-Tzid mapping data</a>. The mapping data is updated time to time. To get the latest changes,
* please read the ICU user guide section <a href="https://unicode-org.github.io/icu/userguide/datetime/timezone#updating-the-time-zone-data">
* Updating the Time Zone Data</a>.
*
* @param winid         A Windows time zone ID.
* @param len           The length of <code>winid</code>, or -1 if null-terminated.
* @param region        A null-terminated region code, or <code>NULL</code> if no regional preference.
* @param id            A buffer to receive a system time zone ID.
* @param idCapacity    The capacity of the result buffer <code>id</code>.
* @param status        Receives the status.
* @return              The result string length, not including the terminating null.
* @see ucal_getWindowsTimeZoneID
*
* @stable ICU 52
*/
U_CAPI int32_t U_EXPORT2
ucal_getTimeZoneIDForWindowsID(const UChar* winid, int32_t len, const char* region,
                                UChar* id, int32_t idCapacity, UErrorCode* status);

/**
 * Options used by ucal_getTimeZoneOffsetFromLocal and BasicTimeZone::getOffsetFromLocal()
 * to specify how to interpret an input time when it does not exist, or when it is ambiguous,
 * around a time zone transition.
 * @stable ICU 69
 */
enum UTimeZoneLocalOption {
    /**
     * An input time is always interpreted as local time before
     * a time zone transition.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_FORMER = 0x04,
    /**
     * An input time is always interpreted as local time after
     * a time zone transition.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_LATTER = 0x0C,
    /**
     * An input time is interpreted as standard time when local
     * time is switched to/from daylight saving time. When both
     * sides of a time zone transition are standard time,
     * or daylight saving time, the local time before the
     * transition is used.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_STANDARD_FORMER = UCAL_TZ_LOCAL_FORMER | 0x01,
    /**
     * An input time is interpreted as standard time when local
     * time is switched to/from daylight saving time. When both
     * sides of a time zone transition are standard time,
     * or daylight saving time, the local time after the
     * transition is used.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_STANDARD_LATTER = UCAL_TZ_LOCAL_LATTER | 0x01,
    /**
     * An input time is interpreted as daylight saving time when
     * local time is switched to/from standard time. When both
     * sides of a time zone transition are standard time,
     * or daylight saving time, the local time before the
     * transition is used.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_DAYLIGHT_FORMER = UCAL_TZ_LOCAL_FORMER | 0x03,
    /**
     * An input time is interpreted as daylight saving time when
     * local time is switched to/from standard time. When both
     * sides of a time zone transition are standard time,
     * or daylight saving time, the local time after the
     * transition is used.
     * @stable ICU 69
     */
    UCAL_TZ_LOCAL_DAYLIGHT_LATTER = UCAL_TZ_LOCAL_LATTER | 0x03,
};
typedef enum UTimeZoneLocalOption UTimeZoneLocalOption; /**< @stable ICU 69 */

/**
* Returns the time zone raw and GMT offset for the given moment
* in time.  Upon return, local-millis = GMT-millis + rawOffset +
* dstOffset.  All computations are performed in the proleptic
* Gregorian calendar.
*
* @param cal The UCalendar which specify the local date and time value to query.
* @param nonExistingTimeOpt The option to indicate how to interpret the date and
* time in the calendar represent a local time that skipped at a positive time
* zone transitions (e.g. when the daylight saving time starts or the time zone
* offset is increased due to a time zone rule change).
* @param duplicatedTimeOpt The option to indicate how to interpret the date and
* time in the calendar represent a local time that repeating multiple times at a
* negative time zone transition (e.g. when the daylight saving time ends or the
* time zone offset is decreased due to a time zone rule change)
* @param rawOffset output parameter to receive the raw offset, that
* is, the offset not including DST adjustments.
* If the status is set to one of the error code, the value set is unspecified.
* @param dstOffset output parameter to receive the DST offset,
* that is, the offset to be added to `rawOffset' to obtain the
* total offset between local and GMT time. If DST is not in
* effect, this value is zero; otherwise it is a positive value,
* typically one hour.
* If the status is set to one of the error code, the value set is unspecified.
* @param status A pointer to a UErrorCode to receive any errors.
* @stable ICU 69
*/
U_CAPI void U_EXPORT2
ucal_getTimeZoneOffsetFromLocal(
    const UCalendar* cal,
    UTimeZoneLocalOption nonExistingTimeOpt,
    UTimeZoneLocalOption duplicatedTimeOpt,
    int32_t* rawOffset, int32_t* dstOffset, UErrorCode* status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
