// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************************
*   Copyright (C) 1997-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
********************************************************************************
*
* File CALENDAR.H
*
* Modification History:
*
*   Date        Name        Description
*   04/22/97    aliu        Expanded and corrected comments and other header
*                           contents.
*   05/01/97    aliu        Made equals(), before(), after() arguments const.
*   05/20/97    aliu        Replaced fAreFieldsSet with fAreFieldsInSync and
*                           fAreAllFieldsSet.
*   07/27/98    stephen     Sync up with JDK 1.2
*   11/15/99    weiv        added YEAR_WOY and DOW_LOCAL
*                           to EDateFields
*    8/19/2002  srl         Removed Javaisms
*   11/07/2003  srl         Update, clean up documentation.
********************************************************************************
*/

#ifndef CALENDAR_H
#define CALENDAR_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C++ API: Calendar object
 */
#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"
#include "unicode/locid.h"
#include "unicode/timezone.h"
#include "unicode/ucal.h"
#include "unicode/umisc.h"

U_NAMESPACE_BEGIN

class ICUServiceFactory;

// Do not conditionalize the following with #ifndef U_HIDE_INTERNAL_API,
// it is a return type for a virtual method (@internal)
/**
 * @internal
 */
typedef int32_t UFieldResolutionTable[12][8];

class BasicTimeZone;
/**
 * `Calendar` is an abstract base class for converting between
 * a `UDate` object and a set of integer fields such as
 * `YEAR`, `MONTH`, `DAY`, `HOUR`, and so on.
 * (A `UDate` object represents a specific instant in
 * time with millisecond precision. See UDate
 * for information about the `UDate` class.)
 *
 * Subclasses of `Calendar` interpret a `UDate`
 * according to the rules of a specific calendar system.
 * The most commonly used subclass of `Calendar` is
 * `GregorianCalendar`. Other subclasses could represent
 * the various types of lunar calendars in use in many parts of the world.
 *
 * **NOTE**: (ICU 2.6) The subclass interface should be considered unstable -
 * it WILL change.
 *
 * Like other locale-sensitive classes, `Calendar` provides a
 * static method, `createInstance`, for getting a generally useful
 * object of this type. `Calendar`'s `createInstance` method
 * returns the appropriate `Calendar` subclass whose
 * time fields have been initialized with the current date and time:
 *
 *     Calendar *rightNow = Calendar::createInstance(errCode);
 *
 * A `Calendar` object can produce all the time field values
 * needed to implement the date-time formatting for a particular language
 * and calendar style (for example, Japanese-Gregorian, Japanese-Traditional).
 *
 * When computing a `UDate` from time fields, some special circumstances
 * may arise: there may be insufficient information to compute the
 * `UDate` (such as only year and month but no day in the month),
 * there may be inconsistent information (such as "Tuesday, July 15, 1996"
 * -- July 15, 1996 is actually a Monday), or the input time might be ambiguous
 * because of time zone transition.
 *
 * **Insufficient information.** The calendar will use default
 * information to specify the missing fields. This may vary by calendar; for
 * the Gregorian calendar, the default for a field is the same as that of the
 * start of the epoch: i.e., YEAR = 1970, MONTH = JANUARY, DATE = 1, etc.
 *
 * **Inconsistent information.** If fields conflict, the calendar
 * will give preference to fields set more recently. For example, when
 * determining the day, the calendar will look for one of the following
 * combinations of fields.  The most recent combination, as determined by the
 * most recently set single field, will be used.
 *
 *     MONTH + DAY_OF_MONTH
 *     MONTH + WEEK_OF_MONTH + DAY_OF_WEEK
 *     MONTH + DAY_OF_WEEK_IN_MONTH + DAY_OF_WEEK
 *     DAY_OF_YEAR
 *     DAY_OF_WEEK + WEEK_OF_YEAR
 *
 * For the time of day:
 *
 *     HOUR_OF_DAY
 *     AM_PM + HOUR
 *
 * **Ambiguous Wall Clock Time.** When time offset from UTC has
 * changed, it produces an ambiguous time slot around the transition. For example,
 * many US locations observe daylight saving time. On the date switching to daylight
 * saving time in US, wall clock time jumps from 12:59 AM (standard) to 2:00 AM
 * (daylight). Therefore, wall clock time from 1:00 AM to 1:59 AM do not exist on
 * the date. When the input wall time fall into this missing time slot, the ICU
 * Calendar resolves the time using the UTC offset before the transition by default.
 * In this example, 1:30 AM is interpreted as 1:30 AM standard time (non-exist),
 * so the final result will be 2:30 AM daylight time.
 *
 * On the date switching back to standard time, wall clock time is moved back one
 * hour at 2:00 AM. So wall clock time from 1:00 AM to 1:59 AM occur twice. In this
 * case, the ICU Calendar resolves the time using the UTC offset after the transition
 * by default. For example, 1:30 AM on the date is resolved as 1:30 AM standard time.
 *
 * Ambiguous wall clock time resolution behaviors can be customized by Calendar APIs
 * {@link #setRepeatedWallTimeOption} and {@link #setSkippedWallTimeOption}.
 * These methods are available in ICU 49 or later versions.
 *
 * **Note:** for some non-Gregorian calendars, different
 * fields may be necessary for complete disambiguation. For example, a full
 * specification of the historical Arabic astronomical calendar requires year,
 * month, day-of-month *and* day-of-week in some cases.
 *
 * **Note:** There are certain possible ambiguities in
 * interpretation of certain singular times, which are resolved in the
 * following ways:
 *
 *   1. 24:00:00 "belongs" to the following day. That is,
 *      23:59 on Dec 31, 1969 < 24:00 on Jan 1, 1970 < 24:01:00 on Jan 1, 1970
 *   2. Although historically not precise, midnight also belongs to "am",
 *      and noon belongs to "pm", so on the same day,
 *      12:00 am (midnight) < 12:01 am, and 12:00 pm (noon) < 12:01 pm
 *
 * The date or time format strings are not part of the definition of a
 * calendar, as those must be modifiable or overridable by the user at
 * runtime. Use `DateFormat` to format dates.
 *
 * `Calendar` provides an API for field "rolling", where fields
 * can be incremented or decremented, but wrap around. For example, rolling the
 * month up in the date December 12, **1996** results in
 * January 12, **1996**.
 *
 * `Calendar` also provides a date arithmetic function for
 * adding the specified (signed) amount of time to a particular time field.
 * For example, subtracting 5 days from the date `September 12, 1996`
 * results in `September 7, 1996`.
 *
 * ***Supported range***
 *
 * The allowable range of `Calendar` has been narrowed. `GregorianCalendar` used
 * to attempt to support the range of dates with millisecond values from
 * `Long.MIN_VALUE` to `Long.MAX_VALUE`. The new `Calendar` protocol specifies the
 * maximum range of supportable dates as those having Julian day numbers
 * of `-0x7F000000` to `+0x7F000000`. This corresponds to years from ~5,800,000 BCE
 * to ~5,800,000 CE. Programmers should use the protected constants in `Calendar` to
 * specify an extremely early or extremely late date.
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
class U_I18N_API_CLASS Calendar : public UObject {
public:
#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Field IDs for date and time. Used to specify date/time fields. ERA is calendar
     * specific. Example ranges given are for illustration only; see specific Calendar
     * subclasses for actual ranges.
     * @deprecated ICU 2.6. Use C enum UCalendarDateFields defined in ucal.h
     */
    enum EDateFields {
#ifndef U_HIDE_DEPRECATED_API
/*
 * ERA may be defined on other platforms. To avoid any potential problems undefined it here.
 */
#ifdef ERA
#undef ERA
#endif
        ERA,                  // Example: 0..1
        YEAR,                 // Example: 1..big number
        MONTH,                // Example: 0..11
        WEEK_OF_YEAR,         // Example: 1..53
        WEEK_OF_MONTH,        // Example: 1..4
        DATE,                 // Example: 1..31
        DAY_OF_YEAR,          // Example: 1..365
        DAY_OF_WEEK,          // Example: 1..7
        DAY_OF_WEEK_IN_MONTH, // Example: 1..4, may be specified as -1
        AM_PM,                // Example: 0..1
        HOUR,                 // Example: 0..11
        HOUR_OF_DAY,          // Example: 0..23
        MINUTE,               // Example: 0..59
        SECOND,               // Example: 0..59
        MILLISECOND,          // Example: 0..999
        ZONE_OFFSET,          // Example: -12*U_MILLIS_PER_HOUR..12*U_MILLIS_PER_HOUR
        DST_OFFSET,           // Example: 0 or U_MILLIS_PER_HOUR
        YEAR_WOY,             // 'Y' Example: 1..big number - Year of Week of Year
        DOW_LOCAL,            // 'e' Example: 1..7 - Day of Week / Localized

        EXTENDED_YEAR,
        JULIAN_DAY,
        MILLISECONDS_IN_DAY,
        IS_LEAP_MONTH,

        FIELD_COUNT = UCAL_FIELD_COUNT // See ucal.h for other fields.
#endif /* U_HIDE_DEPRECATED_API */
    };
#endif  // U_FORCE_HIDE_DEPRECATED_API

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Useful constant for days of week. Note: Calendar day-of-week is 1-based. Clients
     * who create locale resources for the field of first-day-of-week should be aware of
     * this. For instance, in US locale, first-day-of-week is set to 1, i.e., SUNDAY.
     * @deprecated ICU 2.6. Use C enum UCalendarDaysOfWeek defined in ucal.h
     */
    enum EDaysOfWeek {
        SUNDAY = 1,
        MONDAY,
        TUESDAY,
        WEDNESDAY,
        THURSDAY,
        FRIDAY,
        SATURDAY
    };

    /**
     * Useful constants for month. Note: Calendar month is 0-based.
     * @deprecated ICU 2.6. Use C enum UCalendarMonths defined in ucal.h
     */
    enum EMonths {
        JANUARY,
        FEBRUARY,
        MARCH,
        APRIL,
        MAY,
        JUNE,
        JULY,
        AUGUST,
        SEPTEMBER,
        OCTOBER,
        NOVEMBER,
        DECEMBER,
        UNDECIMBER
    };

    /**
     * Useful constants for hour in 12-hour clock. Used in GregorianCalendar.
     * @deprecated ICU 2.6. Use C enum UCalendarAMPMs defined in ucal.h
     */
    enum EAmpm {
        AM,
        PM
    };
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * destructor
     * @stable ICU 2.0
     */
    U_I18N_API virtual ~Calendar();

    /**
     * Create and return a polymorphic copy of this calendar.
     *
     * @return    a polymorphic copy of this calendar.
     * @stable ICU 2.0
     */
    U_I18N_API virtual Calendar* clone() const = 0;

    /**
     * Creates a Calendar using the default timezone and locale. Clients are responsible
     * for deleting the object returned.
     *
     * @param success  Indicates the success/failure of Calendar creation. Filled in
     *                 with U_ZERO_ERROR if created successfully, set to a failure result
     *                 otherwise. U_MISSING_RESOURCE_ERROR will be returned if the resource data
     *                 requests a calendar type which has not been installed.
     * @return         A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(UErrorCode& success);

    /**
     * Creates a Calendar using the given timezone and the default locale.
     * The Calendar takes ownership of zoneToAdopt; the
     * client must not delete it.
     *
     * @param zoneToAdopt  The given timezone to be adopted.
     * @param success      Indicates the success/failure of Calendar creation. Filled in
     *                     with U_ZERO_ERROR if created successfully, set to a failure result
     *                     otherwise.
     * @return             A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(TimeZone* zoneToAdopt, UErrorCode& success);

    /**
     * Creates a Calendar using the given timezone and the default locale.  The TimeZone
     * is _not_ adopted; the client is still responsible for deleting it.
     *
     * @param zone  The timezone.
     * @param success      Indicates the success/failure of Calendar creation. Filled in
     *                     with U_ZERO_ERROR if created successfully, set to a failure result
     *                     otherwise.
     * @return             A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(const TimeZone& zone, UErrorCode& success);

    /**
     * Creates a Calendar using the default timezone and the given locale.
     *
     * @param aLocale  The given locale.
     * @param success  Indicates the success/failure of Calendar creation. Filled in
     *                 with U_ZERO_ERROR if created successfully, set to a failure result
     *                 otherwise.
     * @return         A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(const Locale& aLocale, UErrorCode& success);

    /**
     * Creates a Calendar using the given timezone and given locale.
     * The Calendar takes ownership of zoneToAdopt; the
     * client must not delete it.
     *
     * @param zoneToAdopt  The given timezone to be adopted.
     * @param aLocale      The given locale.
     * @param success      Indicates the success/failure of Calendar creation. Filled in
     *                     with U_ZERO_ERROR if created successfully, set to a failure result
     *                     otherwise.
     * @return             A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(TimeZone* zoneToAdopt,
                                                         const Locale& aLocale,
                                                         UErrorCode& success);

    /**
     * Gets a Calendar using the given timezone and given locale.  The TimeZone
     * is _not_ adopted; the client is still responsible for deleting it.
     *
     * @param zone         The given timezone.
     * @param aLocale      The given locale.
     * @param success      Indicates the success/failure of Calendar creation. Filled in
     *                     with U_ZERO_ERROR if created successfully, set to a failure result
     *                     otherwise.
     * @return             A Calendar if created successfully. nullptr otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API static Calendar* U_EXPORT2 createInstance(const TimeZone& zone,
                                                         const Locale& aLocale,
                                                         UErrorCode& success);

    /**
     * Returns a list of the locales for which Calendars are installed.
     *
     * @param count  Number of locales returned.
     * @return       An array of Locale objects representing the set of locales for which
     *               Calendars are installed.  The system retains ownership of this list;
     *               the caller must NOT delete it. Does not include user-registered Calendars.
     * @stable ICU 2.0
     */
    U_I18N_API static const Locale* U_EXPORT2 getAvailableLocales(int32_t& count);

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
     * @param status        ICU Error Code
     * @return a string enumeration over keyword values for the given key and the locale.
     * @stable ICU 4.2
     */
    U_I18N_API static StringEnumeration* U_EXPORT2 getKeywordValuesForLocale(const char* key,
                                                                             const Locale& locale,
                                                                             UBool commonlyUsed,
                                                                             UErrorCode& status);

    /**
     * Returns the current UTC (GMT) time measured in milliseconds since 0:00:00 on 1/1/70
     * (derived from the system time).
     *
     * @return   The current UTC time in milliseconds.
     * @stable ICU 2.0
     */
    U_I18N_API static UDate U_EXPORT2 getNow();

    /**
     * Gets this Calendar's time as milliseconds. May involve recalculation of time due
     * to previous calls to set time field values. The time specified is non-local UTC
     * (GMT) time. Although this method is const, this object may actually be changed
     * (semantically const).
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @return        The current time in UTC (GMT) time, or zero if the operation
     *                failed.
     * @stable ICU 2.0
     */
    U_I18N_API inline UDate getTime(UErrorCode& status) const { return getTimeInMillis(status); }

    /**
     * Sets this Calendar's current time with the given UDate. The time specified should
     * be in non-local UTC (GMT) time.
     *
     * @param date  The given UDate in UTC (GMT) time.
     * @param status  Output param set to success/failure code on exit. If any value
     *                set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.0
     */
    U_I18N_API inline void setTime(UDate date, UErrorCode& status) { setTimeInMillis(date, status); }

    /**
     * Compares the equality of two Calendar objects. Objects of different subclasses
     * are considered unequal. This comparison is very exacting; two Calendar objects
     * must be in exactly the same state to be considered equal. To compare based on the
     * represented time, use equals() instead.
     *
     * @param that  The Calendar object to be compared with.
     * @return      true if the given Calendar is the same as this Calendar; false
     *              otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API virtual bool operator==(const Calendar& that) const;

    /**
     * Compares the inequality of two Calendar objects.
     *
     * @param that  The Calendar object to be compared with.
     * @return      true if the given Calendar is not the same as this Calendar; false
     *              otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API bool operator!=(const Calendar& that) const { return !operator==(that); }

    /**
     * Returns true if the given Calendar object is equivalent to this
     * one.  An equivalent Calendar will behave exactly as this one
     * does, but it may be set to a different time.  By contrast, for
     * the operator==() method to return true, the other Calendar must
     * be set to the same time.
     *
     * @param other the Calendar to be compared with this Calendar
     * @stable ICU 2.4
     */
    U_I18N_API virtual UBool isEquivalentTo(const Calendar& other) const;

    /**
     * Compares the Calendar time, whereas Calendar::operator== compares the equality of
     * Calendar objects.
     *
     * @param when    The Calendar to be compared with this Calendar. Although this is a
     *                const parameter, the object may be modified physically
     *                (semantically const).
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @return        True if the current time of this Calendar is equal to the time of
     *                Calendar when; false otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API UBool equals(const Calendar& when, UErrorCode& status) const;

    /**
     * Returns true if this Calendar's current time is before "when"'s current time.
     *
     * @param when    The Calendar to be compared with this Calendar. Although this is a
     *                const parameter, the object may be modified physically
     *                (semantically const).
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @return        True if the current time of this Calendar is before the time of
     *                Calendar when; false otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API UBool before(const Calendar& when, UErrorCode& status) const;

    /**
     * Returns true if this Calendar's current time is after "when"'s current time.
     *
     * @param when    The Calendar to be compared with this Calendar. Although this is a
     *                const parameter, the object may be modified physically
     *                (semantically const).
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @return        True if the current time of this Calendar is after the time of
     *                Calendar when; false otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API UBool after(const Calendar& when, UErrorCode& status) const;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * UDate Arithmetic function. Adds the specified (signed) amount of time to the given
     * time field, based on the calendar's rules. For example, to subtract 5 days from
     * the current time of the calendar, call add(Calendar::DATE, -5). When adding on
     * the month or Calendar::MONTH field, other fields like date might conflict and
     * need to be changed. For instance, adding 1 month on the date 01/31/96 will result
     * in 02/29/96.
     * Adding a positive value always means moving forward in time, so for the Gregorian calendar,
     * starting with 100 BC and adding +1 to year results in 99 BC (even though this actually reduces
     * the numeric value of the field itself).
     *
     * @param field   Specifies which date field to modify.
     * @param amount  The amount of time to be added to the field, in the natural unit
     *                for that field (e.g., days for the day fields, hours for the hour
     *                field.)
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @deprecated ICU 2.6. use add(UCalendarDateFields field, int32_t amount, UErrorCode& status) instead.
     */
    U_I18N_API virtual void add(EDateFields field, int32_t amount, UErrorCode& status);
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * UDate Arithmetic function. Adds the specified (signed) amount of time to the given
     * time field, based on the calendar's rules. For example, to subtract 5 days from
     * the current time of the calendar, call add(Calendar::DATE, -5). When adding on
     * the month or Calendar::MONTH field, other fields like date might conflict and
     * need to be changed. For instance, adding 1 month on the date 01/31/96 will result
     * in 02/29/96.
     * Adding a positive value always means moving forward in time, so for the Gregorian calendar,
     * starting with 100 BC and adding +1 to year results in 99 BC (even though this actually reduces
     * the numeric value of the field itself).
     *
     * @param field   Specifies which date field to modify.
     * @param amount  The amount of time to be added to the field, in the natural unit
     *                for that field (e.g., days for the day fields, hours for the hour
     *                field.)
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual void add(UCalendarDateFields field, int32_t amount, UErrorCode& status);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Time Field Rolling function. Rolls (up/down) a single unit of time on the given
     * time field. For example, to roll the current date up by one day, call
     * roll(Calendar::DATE, true). When rolling on the year or Calendar::YEAR field, it
     * will roll the year value in the range between getMinimum(Calendar::YEAR) and the
     * value returned by getMaximum(Calendar::YEAR). When rolling on the month or
     * Calendar::MONTH field, other fields like date might conflict and, need to be
     * changed. For instance, rolling the month up on the date 01/31/96 will result in
     * 02/29/96. Rolling up always means rolling forward in time (unless the limit of the
     * field is reached, in which case it may pin or wrap), so for Gregorian calendar,
     * starting with 100 BC and rolling the year up results in 99 BC.
     * When eras have a definite beginning and end (as in the Chinese calendar, or as in
     * most eras in the Japanese calendar) then rolling the year past either limit of the
     * era will cause the year to wrap around. When eras only have a limit at one end,
     * then attempting to roll the year past that limit will result in pinning the year
     * at that limit. Note that for most calendars in which era 0 years move forward in
     * time (such as Buddhist, Hebrew, or Islamic), it is possible for add or roll to
     * result in negative years for era 0 (that is the only way to represent years before
     * the calendar epoch).
     * When rolling on the hour-in-day or Calendar::HOUR_OF_DAY field, it will roll the
     * hour value in the range between 0 and 23, which is zero-based.
     * <P>
     * NOTE: Do not use this method -- use roll(EDateFields, int, UErrorCode&) instead.
     *
     * @param field   The time field.
     * @param up      Indicates if the value of the specified time field is to be rolled
     *                up or rolled down. Use true if rolling up, false otherwise.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @deprecated ICU 2.6. Use roll(UCalendarDateFields field, UBool up, UErrorCode& status) instead.
     */
    U_I18N_API inline void roll(EDateFields field, UBool up, UErrorCode& status);
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Time Field Rolling function. Rolls (up/down) a single unit of time on the given
     * time field. For example, to roll the current date up by one day, call
     * roll(Calendar::DATE, true). When rolling on the year or Calendar::YEAR field, it
     * will roll the year value in the range between getMinimum(Calendar::YEAR) and the
     * value returned by getMaximum(Calendar::YEAR). When rolling on the month or
     * Calendar::MONTH field, other fields like date might conflict and, need to be
     * changed. For instance, rolling the month up on the date 01/31/96 will result in
     * 02/29/96. Rolling up always means rolling forward in time (unless the limit of the
     * field is reached, in which case it may pin or wrap), so for Gregorian calendar,
     * starting with 100 BC and rolling the year up results in 99 BC.
     * When eras have a definite beginning and end (as in the Chinese calendar, or as in
     * most eras in the Japanese calendar) then rolling the year past either limit of the
     * era will cause the year to wrap around. When eras only have a limit at one end,
     * then attempting to roll the year past that limit will result in pinning the year
     * at that limit. Note that for most calendars in which era 0 years move forward in
     * time (such as Buddhist, Hebrew, or Islamic), it is possible for add or roll to
     * result in negative years for era 0 (that is the only way to represent years before
     * the calendar epoch).
     * When rolling on the hour-in-day or Calendar::HOUR_OF_DAY field, it will roll the
     * hour value in the range between 0 and 23, which is zero-based.
     * <P>
     * NOTE: Do not use this method -- use roll(UCalendarDateFields, int, UErrorCode&) instead.
     *
     * @param field   The time field.
     * @param up      Indicates if the value of the specified time field is to be rolled
     *                up or rolled down. Use true if rolling up, false otherwise.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.6.
     */
    U_I18N_API inline void roll(UCalendarDateFields field, UBool up, UErrorCode& status);

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Time Field Rolling function. Rolls by the given amount on the given
     * time field. For example, to roll the current date up by one day, call
     * roll(Calendar::DATE, +1, status). When rolling on the month or
     * Calendar::MONTH field, other fields like date might conflict and, need to be
     * changed. For instance, rolling the month up on the date 01/31/96 will result in
     * 02/29/96. Rolling by a positive value always means rolling forward in time (unless
     * the limit of the field is reached, in which case it may pin or wrap), so for
     * Gregorian calendar, starting with 100 BC and rolling the year by + 1 results in 99 BC.
     * When eras have a definite beginning and end (as in the Chinese calendar, or as in
     * most eras in the Japanese calendar) then rolling the year past either limit of the
     * era will cause the year to wrap around. When eras only have a limit at one end,
     * then attempting to roll the year past that limit will result in pinning the year
     * at that limit. Note that for most calendars in which era 0 years move forward in
     * time (such as Buddhist, Hebrew, or Islamic), it is possible for add or roll to
     * result in negative years for era 0 (that is the only way to represent years before
     * the calendar epoch).
     * When rolling on the hour-in-day or Calendar::HOUR_OF_DAY field, it will roll the
     * hour value in the range between 0 and 23, which is zero-based.
     * <P>
     * The only difference between roll() and add() is that roll() does not change
     * the value of more significant fields when it reaches the minimum or maximum
     * of its range, whereas add() does.
     *
     * @param field   The time field.
     * @param amount  Indicates amount to roll.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @deprecated ICU 2.6. Use roll(UCalendarDateFields field, int32_t amount, UErrorCode& status) instead.
     */
    U_I18N_API virtual void roll(EDateFields field, int32_t amount, UErrorCode& status);
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Time Field Rolling function. Rolls by the given amount on the given
     * time field. For example, to roll the current date up by one day, call
     * roll(Calendar::DATE, +1, status). When rolling on the month or
     * Calendar::MONTH field, other fields like date might conflict and, need to be
     * changed. For instance, rolling the month up on the date 01/31/96 will result in
     * 02/29/96. Rolling by a positive value always means rolling forward in time (unless
     * the limit of the field is reached, in which case it may pin or wrap), so for
     * Gregorian calendar, starting with 100 BC and rolling the year by + 1 results in 99 BC.
     * When eras have a definite beginning and end (as in the Chinese calendar, or as in
     * most eras in the Japanese calendar) then rolling the year past either limit of the
     * era will cause the year to wrap around. When eras only have a limit at one end,
     * then attempting to roll the year past that limit will result in pinning the year
     * at that limit. Note that for most calendars in which era 0 years move forward in
     * time (such as Buddhist, Hebrew, or Islamic), it is possible for add or roll to
     * result in negative years for era 0 (that is the only way to represent years before
     * the calendar epoch).
     * When rolling on the hour-in-day or Calendar::HOUR_OF_DAY field, it will roll the
     * hour value in the range between 0 and 23, which is zero-based.
     * <P>
     * The only difference between roll() and add() is that roll() does not change
     * the value of more significant fields when it reaches the minimum or maximum
     * of its range, whereas add() does.
     *
     * @param field   The time field.
     * @param amount  Indicates amount to roll.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual void roll(UCalendarDateFields field, int32_t amount, UErrorCode& status);

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Return the difference between the given time and the time this
     * calendar object is set to.  If this calendar is set
     * <em>before</em> the given time, the returned value will be
     * positive.  If this calendar is set <em>after</em> the given
     * time, the returned value will be negative.  The
     * <code>field</code> parameter specifies the units of the return
     * value.  For example, if <code>fieldDifference(when,
     * Calendar::MONTH)</code> returns 3, then this calendar is set to
     * 3 months before <code>when</code>, and possibly some addition
     * time less than one month.
     *
     * <p>As a side effect of this call, this calendar is advanced
     * toward <code>when</code> by the given amount.  That is, calling
     * this method has the side effect of calling <code>add(field,
     * n)</code>, where <code>n</code> is the return value.
     *
     * <p>Usage: To use this method, call it first with the largest
     * field of interest, then with progressively smaller fields.  For
     * example:
     *
     * <pre>
     * int y = cal->fieldDifference(when, Calendar::YEAR, err);
     * int m = cal->fieldDifference(when, Calendar::MONTH, err);
     * int d = cal->fieldDifference(when, Calendar::DATE, err);</pre>
     *
     * computes the difference between <code>cal</code> and
     * <code>when</code> in years, months, and days.
     *
     * <p>Note: <code>fieldDifference()</code> is
     * <em>asymmetrical</em>.  That is, in the following code:
     *
     * <pre>
     * cal->setTime(date1, err);
     * int m1 = cal->fieldDifference(date2, Calendar::MONTH, err);
     * int d1 = cal->fieldDifference(date2, Calendar::DATE, err);
     * cal->setTime(date2, err);
     * int m2 = cal->fieldDifference(date1, Calendar::MONTH, err);
     * int d2 = cal->fieldDifference(date1, Calendar::DATE, err);</pre>
     *
     * one might expect that <code>m1 == -m2 && d1 == -d2</code>.
     * However, this is not generally the case, because of
     * irregularities in the underlying calendar system (e.g., the
     * Gregorian calendar has a varying number of days per month).
     *
     * @param when the date to compare this calendar's time to
     * @param field the field in which to compute the result
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @return the difference, either positive or negative, between
     * this calendar's time and <code>when</code>, in terms of
     * <code>field</code>.
     * @deprecated ICU 2.6. Use fieldDifference(UDate when, UCalendarDateFields field, UErrorCode& status).
     */
    U_I18N_API virtual int32_t fieldDifference(UDate when, EDateFields field, UErrorCode& status);
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Return the difference between the given time and the time this
     * calendar object is set to.  If this calendar is set
     * <em>before</em> the given time, the returned value will be
     * positive.  If this calendar is set <em>after</em> the given
     * time, the returned value will be negative.  The
     * <code>field</code> parameter specifies the units of the return
     * value.  For example, if <code>fieldDifference(when,
     * Calendar::MONTH)</code> returns 3, then this calendar is set to
     * 3 months before <code>when</code>, and possibly some addition
     * time less than one month.
     *
     * <p>As a side effect of this call, this calendar is advanced
     * toward <code>when</code> by the given amount.  That is, calling
     * this method has the side effect of calling <code>add(field,
     * n)</code>, where <code>n</code> is the return value.
     *
     * <p>Usage: To use this method, call it first with the largest
     * field of interest, then with progressively smaller fields.  For
     * example:
     *
     * <pre>
     * int y = cal->fieldDifference(when, Calendar::YEAR, err);
     * int m = cal->fieldDifference(when, Calendar::MONTH, err);
     * int d = cal->fieldDifference(when, Calendar::DATE, err);</pre>
     *
     * computes the difference between <code>cal</code> and
     * <code>when</code> in years, months, and days.
     *
     * <p>Note: <code>fieldDifference()</code> is
     * <em>asymmetrical</em>.  That is, in the following code:
     *
     * <pre>
     * cal->setTime(date1, err);
     * int m1 = cal->fieldDifference(date2, Calendar::MONTH, err);
     * int d1 = cal->fieldDifference(date2, Calendar::DATE, err);
     * cal->setTime(date2, err);
     * int m2 = cal->fieldDifference(date1, Calendar::MONTH, err);
     * int d2 = cal->fieldDifference(date1, Calendar::DATE, err);</pre>
     *
     * one might expect that <code>m1 == -m2 && d1 == -d2</code>.
     * However, this is not generally the case, because of
     * irregularities in the underlying calendar system (e.g., the
     * Gregorian calendar has a varying number of days per month).
     *
     * @param when the date to compare this calendar's time to
     * @param field the field in which to compute the result
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @return the difference, either positive or negative, between
     * this calendar's time and <code>when</code>, in terms of
     * <code>field</code>.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t fieldDifference(UDate when,
                                               UCalendarDateFields field,
                                               UErrorCode& status);

    /**
     * Sets the calendar's time zone to be the one passed in. The Calendar takes ownership
     * of the TimeZone; the caller is no longer responsible for deleting it.  If the
     * given time zone is nullptr, this function has no effect.
     *
     * @param value  The given time zone.
     * @stable ICU 2.0
     */
    U_I18N_API void adoptTimeZone(TimeZone* value);

    /**
     * Sets the calendar's time zone to be the same as the one passed in. The TimeZone
     * passed in is _not_ adopted; the client is still responsible for deleting it.
     *
     * @param zone  The given time zone.
     * @stable ICU 2.0
     */
    U_I18N_API void setTimeZone(const TimeZone& zone);

    /**
     * Returns a reference to the time zone owned by this calendar. The returned reference
     * is only valid until clients make another call to adoptTimeZone or setTimeZone,
     * or this Calendar is destroyed.
     *
     * @return   The time zone object associated with this calendar.
     * @stable ICU 2.0
     */
    U_I18N_API const TimeZone& getTimeZone() const;

    /**
     * Returns the time zone owned by this calendar. The caller owns the returned object
     * and must delete it when done.  After this call, the new time zone associated
     * with this Calendar is the default TimeZone as returned by TimeZone::createDefault().
     *
     * @return   The time zone object which was associated with this calendar.
     * @stable ICU 2.0
     */
    U_I18N_API TimeZone* orphanTimeZone();

    /**
     * Queries if the current date for this Calendar is in Daylight Savings Time.
     *
     * @param status Fill-in parameter which receives the status of this operation.
     * @return   True if the current date for this Calendar is in Daylight Savings Time,
     *           false, otherwise.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UBool inDaylightTime(UErrorCode& status) const;

    /**
     * Specifies whether or not date/time interpretation is to be lenient. With lenient
     * interpretation, a date such as "February 942, 1996" will be treated as being
     * equivalent to the 941st day after February 1, 1996. With strict interpretation,
     * such dates will cause an error when computing time from the time field values
     * representing the dates.
     *
     * @param lenient  True specifies date/time interpretation to be lenient.
     *
     * @see            DateFormat#setLenient
     * @stable ICU 2.0
     */
    U_I18N_API void setLenient(UBool lenient);

    /**
     * Tells whether date/time interpretation is to be lenient.
     *
     * @return   True tells that date/time interpretation is to be lenient.
     * @stable ICU 2.0
     */
    U_I18N_API UBool isLenient() const;

    /**
     * Sets the behavior for handling wall time repeating multiple times
     * at negative time zone offset transitions. For example, 1:30 AM on
     * November 6, 2011 in US Eastern time (America/New_York) occurs twice;
     * 1:30 AM EDT, then 1:30 AM EST one hour later. When <code>UCAL_WALLTIME_FIRST</code>
     * is used, the wall time 1:30AM in this example will be interpreted as 1:30 AM EDT
     * (first occurrence). When <code>UCAL_WALLTIME_LAST</code> is used, it will be
     * interpreted as 1:30 AM EST (last occurrence). The default value is
     * <code>UCAL_WALLTIME_LAST</code>.
     * <p>
     * <b>Note:</b>When <code>UCAL_WALLTIME_NEXT_VALID</code> is not a valid
     * option for this. When the argument is neither <code>UCAL_WALLTIME_FIRST</code>
     * nor <code>UCAL_WALLTIME_LAST</code>, this method has no effect and will keep
     * the current setting.
     *
     * @param option the behavior for handling repeating wall time, either
     * <code>UCAL_WALLTIME_FIRST</code> or <code>UCAL_WALLTIME_LAST</code>.
     * @see #getRepeatedWallTimeOption
     * @stable ICU 49
     */
    U_I18N_API void setRepeatedWallTimeOption(UCalendarWallTimeOption option);

    /**
     * Gets the behavior for handling wall time repeating multiple times
     * at negative time zone offset transitions.
     *
     * @return the behavior for handling repeating wall time, either
     * <code>UCAL_WALLTIME_FIRST</code> or <code>UCAL_WALLTIME_LAST</code>.
     * @see #setRepeatedWallTimeOption
     * @stable ICU 49
     */
    U_I18N_API UCalendarWallTimeOption getRepeatedWallTimeOption() const;

    /**
     * Sets the behavior for handling skipped wall time at positive time zone offset
     * transitions. For example, 2:30 AM on March 13, 2011 in US Eastern time (America/New_York)
     * does not exist because the wall time jump from 1:59 AM EST to 3:00 AM EDT. When
     * <code>UCAL_WALLTIME_FIRST</code> is used, 2:30 AM is interpreted as 30 minutes before 3:00 AM
     * EDT, therefore, it will be resolved as 1:30 AM EST. When <code>UCAL_WALLTIME_LAST</code>
     * is used, 2:30 AM is interpreted as 31 minutes after 1:59 AM EST, therefore, it will be
     * resolved as 3:30 AM EDT. When <code>UCAL_WALLTIME_NEXT_VALID</code> is used, 2:30 AM will
     * be resolved as next valid wall time, that is 3:00 AM EDT. The default value is
     * <code>UCAL_WALLTIME_LAST</code>.
     * <p>
     * <b>Note:</b>This option is effective only when this calendar is lenient.
     * When the calendar is strict, such non-existing wall time will cause an error.
     *
     * @param option the behavior for handling skipped wall time at positive time zone
     * offset transitions, one of <code>UCAL_WALLTIME_FIRST</code>, <code>UCAL_WALLTIME_LAST</code> and
     * <code>UCAL_WALLTIME_NEXT_VALID</code>.
     * @see #getSkippedWallTimeOption
     *
     * @stable ICU 49
     */
    U_I18N_API void setSkippedWallTimeOption(UCalendarWallTimeOption option);

    /**
     * Gets the behavior for handling skipped wall time at positive time zone offset
     * transitions.
     *
     * @return the behavior for handling skipped wall time, one of
     * <code>UCAL_WALLTIME_FIRST</code>, <code>UCAL_WALLTIME_LAST</code>
     * and <code>UCAL_WALLTIME_NEXT_VALID</code>.
     * @see #setSkippedWallTimeOption
     * @stable ICU 49
     */
    U_I18N_API UCalendarWallTimeOption getSkippedWallTimeOption() const;

    /**
     * Sets what the first day of the week is; e.g., Sunday in US, Monday in France.
     *
     * @param value  The given first day of the week.
     * @stable ICU 2.6.
     */
    U_I18N_API void setFirstDayOfWeek(UCalendarDaysOfWeek value);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Gets what the first day of the week is; e.g., Sunday in US, Monday in France.
     *
     * @return   The first day of the week.
     * @deprecated ICU 2.6 use the overload with error code
     */
    U_I18N_API EDaysOfWeek getFirstDayOfWeek() const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Gets what the first day of the week is; e.g., Sunday in US, Monday in France.
     *
     * @param status error code
     * @return   The first day of the week.
     * @stable ICU 2.6
     */
    U_I18N_API UCalendarDaysOfWeek getFirstDayOfWeek(UErrorCode& status) const;

    /**
     * Sets what the minimal days required in the first week of the year are; For
     * example, if the first week is defined as one that contains the first day of the
     * first month of a year, call the method with value 1. If it must be a full week,
     * use value 7.
     *
     * @param value  The given minimal days required in the first week of the year.
     * @stable ICU 2.0
     */
    U_I18N_API void setMinimalDaysInFirstWeek(uint8_t value);

    /**
     * Gets what the minimal days required in the first week of the year are; e.g., if
     * the first week is defined as one that contains the first day of the first month
     * of a year, getMinimalDaysInFirstWeek returns 1. If the minimal days required must
     * be a full week, getMinimalDaysInFirstWeek returns 7.
     *
     * @return   The minimal days required in the first week of the year.
     * @stable ICU 2.0
     */
    U_I18N_API uint8_t getMinimalDaysInFirstWeek() const;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Gets the minimum value for the given time field. e.g., for Gregorian
     * DAY_OF_MONTH, 1.
     *
     * @param field  The given time field.
     * @return       The minimum value for the given time field.
     * @deprecated ICU 2.6. Use getMinimum(UCalendarDateFields field) instead.
     */
    U_I18N_API virtual int32_t getMinimum(EDateFields field) const;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the minimum value for the given time field. e.g., for Gregorian
     * DAY_OF_MONTH, 1.
     *
     * @param field  The given time field.
     * @return       The minimum value for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getMinimum(UCalendarDateFields field) const;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Gets the maximum value for the given time field. e.g. for Gregorian DAY_OF_MONTH,
     * 31.
     *
     * @param field  The given time field.
     * @return       The maximum value for the given time field.
     * @deprecated ICU 2.6. Use getMaximum(UCalendarDateFields field) instead.
     */
    U_I18N_API virtual int32_t getMaximum(EDateFields field) const;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the maximum value for the given time field. e.g. for Gregorian DAY_OF_MONTH,
     * 31.
     *
     * @param field  The given time field.
     * @return       The maximum value for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getMaximum(UCalendarDateFields field) const;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Gets the highest minimum value for the given field if varies. Otherwise same as
     * getMinimum(). For Gregorian, no difference.
     *
     * @param field  The given time field.
     * @return       The highest minimum value for the given time field.
     * @deprecated ICU 2.6. Use getGreatestMinimum(UCalendarDateFields field) instead.
     */
    U_I18N_API virtual int32_t getGreatestMinimum(EDateFields field) const;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the highest minimum value for the given field if varies. Otherwise same as
     * getMinimum(). For Gregorian, no difference.
     *
     * @param field  The given time field.
     * @return       The highest minimum value for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getGreatestMinimum(UCalendarDateFields field) const;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Gets the lowest maximum value for the given field if varies. Otherwise same as
     * getMaximum(). e.g., for Gregorian DAY_OF_MONTH, 28.
     *
     * @param field  The given time field.
     * @return       The lowest maximum value for the given time field.
     * @deprecated ICU 2.6. Use getLeastMaximum(UCalendarDateFields field) instead.
     */
    U_I18N_API virtual int32_t getLeastMaximum(EDateFields field) const;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Gets the lowest maximum value for the given field if varies. Otherwise same as
     * getMaximum(). e.g., for Gregorian DAY_OF_MONTH, 28.
     *
     * @param field  The given time field.
     * @return       The lowest maximum value for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getLeastMaximum(UCalendarDateFields field) const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Return the minimum value that this field could have, given the current date.
     * For the Gregorian calendar, this is the same as getMinimum() and getGreatestMinimum().
     *
     * The version of this function on Calendar uses an iterative algorithm to determine the
     * actual minimum value for the field.  There is almost always a more efficient way to
     * accomplish this (in most cases, you can simply return getMinimum()).  GregorianCalendar
     * overrides this function with a more efficient implementation.
     *
     * @param field    the field to determine the minimum of
     * @param status   Fill-in parameter which receives the status of this operation.
     * @return         the minimum of the given field for the current date of this Calendar
     * @deprecated ICU 2.6. Use getActualMinimum(UCalendarDateFields field, UErrorCode& status) instead.
     */
    U_I18N_API int32_t getActualMinimum(EDateFields field, UErrorCode& status) const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Return the minimum value that this field could have, given the current date.
     * For the Gregorian calendar, this is the same as getMinimum() and getGreatestMinimum().
     *
     * The version of this function on Calendar uses an iterative algorithm to determine the
     * actual minimum value for the field.  There is almost always a more efficient way to
     * accomplish this (in most cases, you can simply return getMinimum()).  GregorianCalendar
     * overrides this function with a more efficient implementation.
     *
     * @param field    the field to determine the minimum of
     * @param status   Fill-in parameter which receives the status of this operation.
     * @return         the minimum of the given field for the current date of this Calendar
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getActualMinimum(UCalendarDateFields field, UErrorCode& status) const;

    /**
     * Return the maximum value that this field could have, given the current date.
     * For example, with the date "Feb 3, 1997" and the DAY_OF_MONTH field, the actual
     * maximum would be 28; for "Feb 3, 1996" it s 29.  Similarly for a Hebrew calendar,
     * for some years the actual maximum for MONTH is 12, and for others 13.
     *
     * The version of this function on Calendar uses an iterative algorithm to determine the
     * actual maximum value for the field.  There is almost always a more efficient way to
     * accomplish this (in most cases, you can simply return getMaximum()).  GregorianCalendar
     * overrides this function with a more efficient implementation.
     *
     * @param field    the field to determine the maximum of
     * @param status   Fill-in parameter which receives the status of this operation.
     * @return         the maximum of the given field for the current date of this Calendar
     * @stable ICU 2.6.
     */
    U_I18N_API virtual int32_t getActualMaximum(UCalendarDateFields field, UErrorCode& status) const;

    /**
     * Gets the value for a given time field. Recalculate the current time field values
     * if the time value has been changed by a call to setTime(). Return zero for unset
     * fields if any fields have been explicitly set by a call to set(). To force a
     * recomputation of all fields regardless of the previous state, call complete().
     * This method is semantically const, but may alter the object in memory.
     *
     * @param field  The given time field.
     * @param status Fill-in parameter which receives the status of the operation.
     * @return       The value for the given time field, or zero if the field is unset,
     *               and set() has been called for any other field.
     * @stable ICU 2.6.
     */
    U_I18N_API int32_t get(UCalendarDateFields field, UErrorCode& status) const;

    /**
     * Determines if the given time field has a value set. This can affect in the
     * resolving of time in Calendar. Unset fields have a value of zero, by definition.
     *
     * @param field  The given time field.
     * @return   True if the given time field has a value set; false otherwise.
     * @stable ICU 2.6.
     */
    U_I18N_API UBool isSet(UCalendarDateFields field) const;

    /**
     * Sets the given time field with the given value.
     *
     * @param field  The given time field.
     * @param value  The value to be set for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API void set(UCalendarDateFields field, int32_t value);

    /**
     * Sets the values for the fields YEAR, MONTH, and DATE. Other field values are
     * retained; call clear() first if this is not desired.
     *
     * @param year   The value used to set the YEAR time field.
     * @param month  The value used to set the MONTH time field. Month value is 0-based.
     *               e.g., 0 for January.
     * @param date   The value used to set the DATE time field.
     * @stable ICU 2.0
     */
    U_I18N_API void set(int32_t year, int32_t month, int32_t date);

    /**
     * Sets the values for the fields YEAR, MONTH, DATE, HOUR_OF_DAY, and MINUTE. Other
     * field values are retained; call clear() first if this is not desired.
     *
     * @param year    The value used to set the YEAR time field.
     * @param month   The value used to set the MONTH time field. Month value is
     *                0-based. E.g., 0 for January.
     * @param date    The value used to set the DATE time field.
     * @param hour    The value used to set the HOUR_OF_DAY time field.
     * @param minute  The value used to set the MINUTE time field.
     * @stable ICU 2.0
     */
    U_I18N_API void set(int32_t year, int32_t month, int32_t date, int32_t hour, int32_t minute);

    /**
     * Sets the values for the fields YEAR, MONTH, DATE, HOUR_OF_DAY, MINUTE, and SECOND.
     * Other field values are retained; call clear() first if this is not desired.
     *
     * @param year    The value used to set the YEAR time field.
     * @param month   The value used to set the MONTH time field. Month value is
     *                0-based. E.g., 0 for January.
     * @param date    The value used to set the DATE time field.
     * @param hour    The value used to set the HOUR_OF_DAY time field.
     * @param minute  The value used to set the MINUTE time field.
     * @param second  The value used to set the SECOND time field.
     * @stable ICU 2.0
     */
    U_I18N_API void set(int32_t year, int32_t month, int32_t date,
                        int32_t hour, int32_t minute, int32_t second);

    /**
     * Clears the values of all the time fields, making them both unset and assigning
     * them a value of zero. The field values will be determined during the next
     * resolving of time into time fields.
     * @stable ICU 2.0
     */
    U_I18N_API void clear();

    /**
     * Clears the value in the given time field, both making it unset and assigning it a
     * value of zero. This field value will be determined during the next resolving of
     * time into time fields. Clearing UCAL_ORDINAL_MONTH or UCAL_MONTH will
     * clear both fields.
     *
     * @param field  The time field to be cleared.
     * @stable ICU 2.6.
     */
    U_I18N_API void clear(UCalendarDateFields field);

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual method. This method is to
     * implement a simple version of RTTI, since not all C++ compilers support genuine
     * RTTI. Polymorphic operator==() and clone() methods call this method.
     * <P>
     * Concrete subclasses of Calendar must implement getDynamicClassID() and also a
     * static method and data member:
     *
     *      static UClassID getStaticClassID() { return (UClassID)&amp;fgClassID; }
     *      static char fgClassID;
     *
     * @return   The class ID for this object. All objects of a given class have the
     *           same class ID. Objects of other classes have different class IDs.
     * @stable ICU 2.0
     */
    U_I18N_API virtual UClassID getDynamicClassID() const override = 0;

    /**
     * Returns the calendar type name string for this Calendar object.
     * The returned string is the legacy ICU calendar attribute value,
     * for example, "gregorian" or "japanese".
     *
     * See type="old type name" for the calendar attribute of locale IDs
     * at http://www.unicode.org/reports/tr35/#Key_Type_Definitions
     *
     * Sample code for getting the LDML/BCP 47 calendar key value:
     * \code
     * const char *calType = cal->getType();
     * if (0 == strcmp(calType, "unknown")) {
     *     // deal with unknown calendar type
     * } else {
     *     string localeID("root@calendar=");
     *     localeID.append(calType);
     *     char langTag[100];
     *     UErrorCode errorCode = U_ZERO_ERROR;
     *     int32_t length = uloc_toLanguageTag(localeID.c_str(), langTag, (int32_t)sizeof(langTag), true, &errorCode);
     *     if (U_FAILURE(errorCode)) {
     *         // deal with errors & overflow
     *     }
     *     string lang(langTag, length);
     *     size_t caPos = lang.find("-ca-");
     *     lang.erase(0, caPos + 4);
     *     // lang now contains the LDML calendar type
     * }
     * \endcode
     *
     * @return legacy calendar type name string
     * @stable ICU 49
     */
    U_I18N_API virtual const char* getType() const = 0;

    /**
     * Returns whether the given day of the week is a weekday, a weekend day,
     * or a day that transitions from one to the other, for the locale and
     * calendar system associated with this Calendar (the locale's region is
     * often the most determinant factor). If a transition occurs at midnight,
     * then the days before and after the transition will have the
     * type UCAL_WEEKDAY or UCAL_WEEKEND. If a transition occurs at a time
     * other than midnight, then the day of the transition will have
     * the type UCAL_WEEKEND_ONSET or UCAL_WEEKEND_CEASE. In this case, the
     * method getWeekendTransition() will return the point of
     * transition.
     * @param dayOfWeek The day of the week whose type is desired (UCAL_SUNDAY..UCAL_SATURDAY).
     * @param status The error code for the operation.
     * @return The UCalendarWeekdayType for the day of the week.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UCalendarWeekdayType getDayOfWeekType(UCalendarDaysOfWeek dayOfWeek,
                                                             UErrorCode& status) const;

    /**
     * Returns the time during the day at which the weekend begins or ends in
     * this calendar system.  If getDayOfWeekType() returns UCAL_WEEKEND_ONSET
     * for the specified dayOfWeek, return the time at which the weekend begins.
     * If getDayOfWeekType() returns UCAL_WEEKEND_CEASE for the specified dayOfWeek,
     * return the time at which the weekend ends. If getDayOfWeekType() returns
     * some other UCalendarWeekdayType for the specified dayOfWeek, is it an error condition
     * (U_ILLEGAL_ARGUMENT_ERROR).
     * @param dayOfWeek The day of the week for which the weekend transition time is
     * desired (UCAL_SUNDAY..UCAL_SATURDAY).
     * @param status The error code for the operation.
     * @return The milliseconds after midnight at which the weekend begins or ends.
     * @stable ICU 4.4
     */
    U_I18N_API virtual int32_t getWeekendTransition(UCalendarDaysOfWeek dayOfWeek,
                                                    UErrorCode& status) const;

    /**
     * Returns true if the given UDate is in the weekend in
     * this calendar system.
     * @param date The UDate in question.
     * @param status The error code for the operation.
     * @return true if the given UDate is in the weekend in
     * this calendar system, false otherwise.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UBool isWeekend(UDate date, UErrorCode& status) const;

    /**
     * Returns true if this Calendar's current date-time is in the weekend in
     * this calendar system.
     * @return true if this Calendar's current date-time is in the weekend in
     * this calendar system, false otherwise.
     * @stable ICU 4.4
     */
    U_I18N_API virtual UBool isWeekend() const;

    /**
     * Returns true if the date is in a leap year. Recalculate the current time
     * field values if the time value has been changed by a call to * setTime().
     * This method is semantically const, but may alter the object in memory.
     * A "leap year" is a year that contains more days than other years (for
     * solar or lunar calendars) or more months than other years (for lunisolar
     * calendars like Hebrew or Chinese), as defined in the ECMAScript Temporal
     * proposal.
     *
     * @param status        ICU Error Code
     * @return       True if the date in the fields is in a Temporal proposal
     *               defined leap year. False otherwise.
     * @stable ICU 73
     */
    U_I18N_API virtual bool inTemporalLeapYear(UErrorCode& status) const;

    /**
     * Gets The Temporal monthCode value corresponding to the month for the date.
     * The value is a string identifier that starts with the literal grapheme
     * "M" followed by two graphemes representing the zero-padded month number
     * of the current month in a normal (non-leap) year and suffixed by an
     * optional literal grapheme "L" if this is a leap month in a lunisolar
     * calendar. The 25 possible values are "M01" .. "M13" and "M01L" .. "M12L".
     * For the Hebrew calendar, the values are "M01" .. "M12" for non-leap year, and
     * "M01" .. "M05", "M05L", "M06" .. "M12" for leap year.
     * For the Chinese calendar, the values are "M01" .. "M12" for non-leap year and
     * in leap year with another monthCode in "M01L" .. "M12L".
     * For Coptic and Ethiopian calendar, the Temporal monthCode values for any
     * years are "M01" to "M13".
     *
     * @param status        ICU Error Code
     * @return       One of 25 possible strings in {"M01".."M13", "M01L".."M12L"}.
     * @stable ICU 73
     */
    U_I18N_API virtual const char* getTemporalMonthCode(UErrorCode& status) const;

    /**
     * Sets The Temporal monthCode which is a string identifier that starts
     * with the literal grapheme "M" followed by two graphemes representing
     * the zero-padded month number of the current month in a normal
     * (non-leap) year and suffixed by an optional literal grapheme "L" if this
     * is a leap month in a lunisolar calendar. The 25 possible values are
     * "M01" .. "M13" and "M01L" .. "M12L". For Hebrew calendar, the values are
     * "M01" .. "M12" for non-leap years, and "M01" .. "M05", "M05L", "M06"
     * .. "M12" for leap year.
     * For the Chinese calendar, the values are "M01" .. "M12" for non-leap year and
     * in leap year with another monthCode in "M01L" .. "M12L".
     * For Coptic and Ethiopian calendar, the Temporal monthCode values for any
     * years are "M01" to "M13".
     *
     * @param temporalMonth  The value to be set for temporal monthCode.
     * @param status        ICU Error Code
     *
     * @stable ICU 73
     */
    U_I18N_API virtual void setTemporalMonthCode(const char* temporalMonth, UErrorCode& status);

protected:

     /**
      * Constructs a Calendar with the default time zone as returned by
      * TimeZone::createInstance(), and the default locale.
      *
      * @param success  Indicates the status of Calendar object construction. Returns
      *                 U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
      */
    U_I18N_API Calendar(UErrorCode& success);

    /**
     * Copy constructor
     *
     * @param source    Calendar object to be copied from
     * @stable ICU 2.0
     */
    U_I18N_API Calendar(const Calendar& source);

    /**
     * Default assignment operator
     *
     * @param right    Calendar object to be copied
     * @stable ICU 2.0
     */
    U_I18N_API Calendar& operator=(const Calendar& right);

    /**
     * Constructs a Calendar with the given time zone and locale. Clients are no longer
     * responsible for deleting the given time zone object after it's adopted.
     *
     * @param zone     The given time zone.
     * @param aLocale  The given locale.
     * @param success  Indicates the status of Calendar object construction. Returns
     *                 U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    U_I18N_API Calendar(TimeZone* zone, const Locale& aLocale, UErrorCode& success);

    /**
     * Constructs a Calendar with the given time zone and locale.
     *
     * @param zone     The given time zone.
     * @param aLocale  The given locale.
     * @param success  Indicates the status of Calendar object construction. Returns
     *                 U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    U_I18N_API Calendar(const TimeZone& zone, const Locale& aLocale, UErrorCode& success);

    /**
     * Converts Calendar's time field values to GMT as milliseconds.
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void computeTime(UErrorCode& status);

    /**
     * Converts GMT as milliseconds to time field values. This allows you to sync up the
     * time field values with a new time that is set for the calendar.  This method
     * does NOT recompute the time first; to recompute the time, then the fields, use
     * the method complete().
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.0
     */
    U_I18N_API virtual void computeFields(UErrorCode& status);

    /**
     * Gets this Calendar's current time as a long.
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @return the current time as UTC milliseconds from the epoch.
     * @stable ICU 2.0
     */
    U_I18N_API double getTimeInMillis(UErrorCode& status) const;

    /**
     * Sets this Calendar's current time from the given long value.
     * @param millis  the new time in UTC milliseconds from the epoch.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.0
     */
    U_I18N_API void setTimeInMillis(double millis, UErrorCode& status);

    /**
     * Recomputes the current time from currently set fields, and then fills in any
     * unset fields in the time field list.
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     * @stable ICU 2.0
     */
    U_I18N_API void complete(UErrorCode& status);

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Gets the value for a given time field. Subclasses can use this function to get
     * field values without forcing recomputation of time.
     *
     * @param field  The given time field.
     * @return       The value for the given time field.
     * @deprecated ICU 2.6. Use internalGet(UCalendarDateFields field) instead.
     */
    U_I18N_API inline int32_t internalGet(EDateFields field) const { return fFields[field]; }
#endif  /* U_HIDE_DEPRECATED_API */

#ifndef U_HIDE_INTERNAL_API
    /**
     * Gets the value for a given time field. Subclasses can use this function to get
     * field values without forcing recomputation of time. If the field's stamp is UNSET,
     * the defaultValue is used.
     *
     * @param field  The given time field.
     * @param defaultValue a default value used if the field is unset.
     * @return       The value for the given time field.
     * @internal
     */
    U_I18N_API inline int32_t internalGet(UCalendarDateFields field, int32_t defaultValue) const {
        return fStamp[field] > kUnset ? fFields[field] : defaultValue;
    }

    /**
     * Gets the value for a given time field. Subclasses can use this function to get
     * field values without forcing recomputation of time.
     *
     * @param field  The given time field.
     * @return       The value for the given time field.
     * @internal
     */
    U_I18N_API inline int32_t internalGet(UCalendarDateFields field) const { return fFields[field]; }

    /**
     * The year in this calendar is counting from 1 backward if the era is 0.
     * @return The year in era 0 of this calendar is counting backward from 1.
     * @internal
     */
    U_I18N_API virtual bool isEra0CountingBackward() const { return false; }

    /**
     * Related year difference.
     * @return The difference in Related year.
     * @internal
     */
    U_I18N_API virtual int32_t getRelatedYearDifference() const;

#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Use this function instead of internalGet(UCAL_MONTH). The implementation
     * check the timestamp of UCAL_MONTH and UCAL_ORDINAL_MONTH and use the
     * one set later. The subclass should override it to conver the value of UCAL_ORDINAL_MONTH
     * to UCAL_MONTH correctly if UCAL_ORDINAL_MONTH has higher priority.
     *
     * @return       The value for the UCAL_MONTH.
     * @internal
     */
    U_I18N_API virtual int32_t internalGetMonth(UErrorCode& status) const;

    /**
     * Use this function instead of internalGet(UCAL_MONTH, defaultValue). The implementation
     * check the timestamp of UCAL_MONTH and UCAL_ORDINAL_MONTH and use the
     * one set later. The subclass should override it to conver the value of UCAL_ORDINAL_MONTH
     * to UCAL_MONTH correctly if UCAL_ORDINAL_MONTH has higher priority.
     *
     * @param defaultValue a default value used if the UCAL_MONTH and
     *   UCAL_ORDINAL are both unset.
     * @param status Output param set to failure code on function return
     *          when this function fails.
     * @return       The value for the UCAL_MONTH.
     * @internal
     */
    U_I18N_API virtual int32_t internalGetMonth(int32_t defaultValue, UErrorCode& status) const;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Sets the value for a given time field.  This is a fast internal method for
     * subclasses.  It does not affect the areFieldsInSync, isTimeSet, or areAllFieldsSet
     * flags.
     *
     * @param field    The given time field.
     * @param value    The value for the given time field.
     * @deprecated ICU 2.6. Use internalSet(UCalendarDateFields field, int32_t value) instead.
     */
    U_I18N_API void internalSet(EDateFields field, int32_t value);
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Sets the value for a given time field.  This is a fast internal method for
     * subclasses.  It does not affect the areFieldsInSync, isTimeSet, or areAllFieldsSet
     * flags.
     *
     * @param field    The given time field.
     * @param value    The value for the given time field.
     * @stable ICU 2.6.
     */
    U_I18N_API inline void internalSet(UCalendarDateFields field, int32_t value);

    /**
     * Prepare this calendar for computing the actual minimum or maximum.
     * This method modifies this calendar's fields; it is called on a
     * temporary calendar.
     * @internal
     */
    U_I18N_API virtual void prepareGetActual(UCalendarDateFields field,
                                             UBool isMinimum,
                                             UErrorCode& status);

    /**
     * Limit enums. Not in sync with UCalendarLimitType (refers to internal fields).
     * @internal
     */
    enum ELimitType {
#ifndef U_HIDE_INTERNAL_API
      UCAL_LIMIT_MINIMUM = 0,
      UCAL_LIMIT_GREATEST_MINIMUM,
      UCAL_LIMIT_LEAST_MAXIMUM,
      UCAL_LIMIT_MAXIMUM,
      UCAL_LIMIT_COUNT
#endif  /* U_HIDE_INTERNAL_API */
    };

    /**
     * Subclass API for defining limits of different types.
     * Subclasses must implement this method to return limits for the
     * following fields:
     *
     * <pre>UCAL_ERA
     * UCAL_YEAR
     * UCAL_MONTH
     * UCAL_WEEK_OF_YEAR
     * UCAL_WEEK_OF_MONTH
     * UCAL_DATE (DAY_OF_MONTH on Java)
     * UCAL_DAY_OF_YEAR
     * UCAL_DAY_OF_WEEK_IN_MONTH
     * UCAL_YEAR_WOY
     * UCAL_EXTENDED_YEAR</pre>
     *
     * @param field one of the above field numbers
     * @param limitType one of <code>MINIMUM</code>, <code>GREATEST_MINIMUM</code>,
     * <code>LEAST_MAXIMUM</code>, or <code>MAXIMUM</code>
     * @internal
     */
    U_I18N_API virtual int32_t handleGetLimit(UCalendarDateFields field, ELimitType limitType) const = 0;

    /**
     * Return a limit for a field.
     * @param field the field, from <code>0..UCAL_MAX_FIELD</code>
     * @param limitType the type specifier for the limit
     * @see #ELimitType
     * @internal
     */
    U_I18N_API virtual int32_t getLimit(UCalendarDateFields field, ELimitType limitType) const;

    /**
     * Return the Julian day number of day before the first day of the
     * given month in the given extended year.  Subclasses should override
     * this method to implement their calendar system.
     * @param eyear the extended year
     * @param month the zero-based month, or 0 if useMonth is false
     * @param useMonth if false, compute the day before the first day of
     * the given year, otherwise, compute the day before the first day of
     * the given month
     * @param status Output param set to failure code on function return
     *          when this function fails.
     * @return the Julian day number of the day before the first
     * day of the given month and year
     * @internal
     */
    U_I18N_API virtual int64_t handleComputeMonthStart(int32_t eyear,
                                                       int32_t month,
                                                       UBool useMonth,
                                                       UErrorCode& status) const = 0;

    /**
     * Return the number of days in the given month of the given extended
     * year of this calendar system.  Subclasses should override this
     * method if they can provide a more correct or more efficient
     * implementation than the default implementation in Calendar.
     * @internal
     */
    U_I18N_API virtual int32_t handleGetMonthLength(int32_t extendedYear,
                                                    int32_t month,
                                                    UErrorCode& status) const;

    /**
     * Return the number of days in the given extended year of this
     * calendar system.  Subclasses should override this method if they can
     * provide a more correct or more efficient implementation than the
     * default implementation in Calendar.
     * @internal
     */
    U_I18N_API virtual int32_t handleGetYearLength(int32_t eyear, UErrorCode& status) const;

    /**
     * Return the extended year defined by the current fields.  This will
     * use the UCAL_EXTENDED_YEAR field or the UCAL_YEAR and supra-year fields (such
     * as UCAL_ERA) specific to the calendar system, depending on which set of
     * fields is newer.
     * @param status        ICU Error Code
     * @return the extended year
     * @internal
     */
    U_I18N_API virtual int32_t handleGetExtendedYear(UErrorCode& status) = 0;

    /**
     * Subclasses may override this.  This method calls
     * handleGetMonthLength() to obtain the calendar-specific month
     * length.
     * @param bestField which field to use to calculate the date
     * @param status        ICU Error Code
     * @return julian day specified by calendar fields.
     * @internal
     */
    U_I18N_API virtual int32_t handleComputeJulianDay(UCalendarDateFields bestField, UErrorCode& status);

    /**
     * Subclasses must override this to convert from week fields
     * (YEAR_WOY and WEEK_OF_YEAR) to an extended year in the case
     * where YEAR, EXTENDED_YEAR are not set.
     * The Calendar implementation assumes yearWoy is in extended gregorian form
     * @return the extended year, UCAL_EXTENDED_YEAR
     * @internal
     */
    U_I18N_API virtual int32_t handleGetExtendedYearFromWeekFields(int32_t yearWoy,
                                                                   int32_t woy,
                                                                   UErrorCode& status);

    /**
     * Validate a single field of this calendar.  Subclasses should
     * override this method to validate any calendar-specific fields.
     * Generic fields can be handled by `Calendar::validateField()`.
     * @internal
     */
    U_I18N_API virtual void validateField(UCalendarDateFields field, UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Compute the Julian day from fields.  Will determine whether to use
     * the JULIAN_DAY field directly, or other fields.
     * @param status        ICU Error Code
     * @return the julian day
     * @internal
     */
    U_I18N_API int32_t computeJulianDay(UErrorCode& status);

    /**
     * Compute the milliseconds in the day from the fields.  This is a
     * value from 0 to 23:59:59.999 inclusive, unless fields are out of
     * range, in which case it can be an arbitrary value.  This value
     * reflects local zone wall time.
     * @internal
     */
    U_I18N_API double computeMillisInDay();

    /**
     * This method can assume EXTENDED_YEAR has been set.
     * @param millis milliseconds of the date fields
     * @param millisInDay milliseconds of the time fields; may be out
     * or range.
     * @param ec Output param set to failure code on function return
     *          when this function fails.
     * @internal
     */
    U_I18N_API int32_t computeZoneOffset(double millis, double millisInDay, UErrorCode& ec);

    /**
     * Determine the best stamp in a range.
     * @param start first enum to look at
     * @param end last enum to look at
     * @param bestSoFar stamp prior to function call
     * @return the stamp value of the best stamp
     * @internal
     */
    U_I18N_API int32_t newestStamp(UCalendarDateFields start,
                                   UCalendarDateFields end,
                                   int32_t bestSoFar) const;

    /**
     * Marker for end of resolve set (row or group). Value for field resolution tables.
     *
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static constexpr int32_t kResolveSTOP = -1;

    /**
     * Value to be bitwised "ORed" against resolve table field values for remapping.
     * Example: (UCAL_DATE | kResolveRemap) in 1st column will cause 'UCAL_DATE' to be returned,
     * but will not examine the value of UCAL_DATE.
     * Value for field resolution tables.
     *
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static constexpr int32_t kResolveRemap = 32;

    /**
     * Precedence table for Dates
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static const UFieldResolutionTable kDatePrecedence[];

    /**
     * Precedence table for Year
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static const UFieldResolutionTable kYearPrecedence[];

    /**
     * Precedence table for Day of Week
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static const UFieldResolutionTable kDOWPrecedence[];

    /**
     * Precedence table for Months
     * @see #resolveFields
     * @internal
     */
    U_I18N_API static const UFieldResolutionTable kMonthPrecedence[];

    /**
     * Given a precedence table, return the newest field combination in
     * the table, or UCAL_FIELD_COUNT if none is found.
     *
     * <p>The precedence table is a 3-dimensional array of integers.  It
     * may be thought of as an array of groups.  Each group is an array of
     * lines.  Each line is an array of field numbers.  Within a line, if
     * all fields are set, then the time stamp of the line is taken to be
     * the stamp of the most recently set field.  If any field of a line is
     * unset, then the line fails to match.  Within a group, the line with
     * the newest time stamp is selected.  The first field of the line is
     * returned to indicate which line matched.
     *
     * <p>In some cases, it may be desirable to map a line to field that
     * whose stamp is NOT examined.  For example, if the best field is
     * DAY_OF_WEEK then the DAY_OF_WEEK_IN_MONTH algorithm may be used.  In
     * order to do this, insert the value <code>kResolveRemap | F</code> at
     * the start of the line, where <code>F</code> is the desired return
     * field value.  This field will NOT be examined; it only determines
     * the return value if the other fields in the line are the newest.
     *
     * <p>If all lines of a group contain at least one unset field, then no
     * line will match, and the group as a whole will fail to match.  In
     * that case, the next group will be processed.  If all groups fail to
     * match, then UCAL_FIELD_COUNT is returned.
     * @internal
     */
    U_I18N_API UCalendarDateFields resolveFields(const UFieldResolutionTable* precedenceTable) const;
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * @internal
     */
    U_I18N_API virtual const UFieldResolutionTable* getFieldResolutionTable() const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * Return the field that is newer, either defaultField, or
     * alternateField.  If neither is newer or neither is set, return defaultField.
     * @internal
     */
    U_I18N_API UCalendarDateFields newerField(UCalendarDateFields defaultField,
                                              UCalendarDateFields alternateField) const;
#endif  /* U_HIDE_INTERNAL_API */


private:
    /**
     * Helper function for calculating limits by trial and error
     * @param field The field being investigated
     * @param startValue starting (least max) value of field
     * @param endValue ending (greatest max) value of field
     * @param status return type
     */
    int32_t getActualHelper(UCalendarDateFields field, int32_t startValue, int32_t endValue, UErrorCode &status) const;

protected:
    /**
     * Get the current time without recomputing.
     *
     * @return     the current time without recomputing.
     * @stable ICU 2.0
     */
    U_I18N_API UDate internalGetTime() const { return fTime; }

    /**
     * Set the current time without affecting flags or fields.
     *
     * @param time    The time to be set
     * @return        the current time without recomputing.
     * @stable ICU 2.0
     */
    U_I18N_API void internalSetTime(UDate time) { fTime = time; }

    /**
     * The time fields containing values into which the millis is computed.
     * @stable ICU 2.0
     */
    int32_t     fFields[UCAL_FIELD_COUNT];

protected:
    /** Special values of stamp[]
     * @stable ICU 2.0
     */
    enum {
        kUnset                 = 0,
        kInternallySet,
        kMinimumUserStamp
    };

private:
    /**
     * Pseudo-time-stamps which specify when each field was set. There
     * are two special values, UNSET and INTERNALLY_SET. Values from
     * MINIMUM_USER_SET to STAMP_MAX are legal user set values.
     */
    int8_t        fStamp[UCAL_FIELD_COUNT];

protected:
    /**
     * Subclasses may override this method to compute several fields
     * specific to each calendar system.  These are:
     *
     * <ul><li>ERA
     * <li>YEAR
     * <li>MONTH
     * <li>DAY_OF_MONTH
     * <li>DAY_OF_YEAR
     * <li>EXTENDED_YEAR</ul>
     *
     * Subclasses can refer to the DAY_OF_WEEK and DOW_LOCAL fields, which
     * will be set when this method is called.  Subclasses can also call
     * the getGregorianXxx() methods to obtain Gregorian calendar
     * equivalents for the given Julian day.
     *
     * <p>In addition, subclasses should compute any subclass-specific
     * fields, that is, fields from BASE_FIELD_COUNT to
     * getFieldCount() - 1.
     *
     * <p>The default implementation in <code>Calendar</code> implements
     * a pure proleptic Gregorian calendar.
     * @internal
     */
  U_I18N_API virtual void handleComputeFields(int32_t julianDay, UErrorCode& status);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Return the extended year on the Gregorian calendar as computed by
     * <code>computeGregorianFields()</code>.
     * @internal
     */
    U_I18N_API int32_t getGregorianYear() const {
        return fGregorianYear;
    }

    /**
     * Return the month (0-based) on the Gregorian calendar as computed by
     * <code>computeGregorianFields()</code>.
     * @internal
     */
    U_I18N_API int32_t getGregorianMonth() const {
        return fGregorianMonth;
    }

    /**
     * Return the day of year (1-based) on the Gregorian calendar as
     * computed by <code>computeGregorianFields()</code>.
     * @internal
     */
    U_I18N_API int32_t getGregorianDayOfYear() const {
        return fGregorianDayOfYear;
    }

    /**
     * Return the day of month (1-based) on the Gregorian calendar as
     * computed by <code>computeGregorianFields()</code>.
     * @internal
     */
    U_I18N_API int32_t getGregorianDayOfMonth() const {
      return fGregorianDayOfMonth;
    }
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Called by computeJulianDay.  Returns the default month (0-based) for the year,
     * taking year and era into account.  Defaults to 0 for Gregorian, which doesn't care.
     * @param eyear The extended year
     * @param status Output param set to failure code on function return
     *          when this function fails.
     * @internal
     */
    U_I18N_API virtual int32_t getDefaultMonthInYear(int32_t eyear, UErrorCode& status);

    /**
     * Called by computeJulianDay.  Returns the default day (1-based) for the month,
     * taking currently-set year and era into account.  Defaults to 1 for Gregorian.
     * @param eyear the extended year
     * @param month the month in the year
     * @param status Output param set to failure code on function return
     *          when this function fails.
     * @internal
     */
    U_I18N_API virtual int32_t getDefaultDayInMonth(int32_t eyear, int32_t month, UErrorCode& status);

    //-------------------------------------------------------------------------
    // Protected utility methods for use by subclasses.  These are very handy
    // for implementing add, roll, and computeFields.
    //-------------------------------------------------------------------------

    /**
     * Adjust the specified field so that it is within
     * the allowable range for the date to which this calendar is set.
     * For example, in a Gregorian calendar pinning the {@link #UCalendarDateFields DAY_OF_MONTH}
     * field for a calendar set to April 31 would cause it to be set
     * to April 30.
     * <p>
     * <b>Subclassing:</b>
     * <br>
     * This utility method is intended for use by subclasses that need to implement
     * their own overrides of {@link #roll roll} and {@link #add add}.
     * <p>
     * <b>Note:</b>
     * <code>pinField</code> is implemented in terms of
     * {@link #getActualMinimum getActualMinimum}
     * and {@link #getActualMaximum getActualMaximum}.  If either of those methods uses
     * a slow, iterative algorithm for a particular field, it would be
     * unwise to attempt to call <code>pinField</code> for that field.  If you
     * really do need to do so, you should override this method to do
     * something more efficient for that field.
     * <p>
     * @param field The calendar field whose value should be pinned.
     * @param status Output param set to failure code on function return
     *          when this function fails.
     *
     * @see #getActualMinimum
     * @see #getActualMaximum
     * @stable ICU 2.0
     */
    U_I18N_API virtual void pinField(UCalendarDateFields field, UErrorCode& status);

    /**
     * Return the week number of a day, within a period. This may be the week number in
     * a year or the week number in a month. Usually this will be a value >= 1, but if
     * some initial days of the period are excluded from week 1, because
     * {@link #getMinimalDaysInFirstWeek getMinimalDaysInFirstWeek} is > 1, then
     * the week number will be zero for those
     * initial days. This method requires the day number and day of week for some
     * known date in the period in order to determine the day of week
     * on the desired day.
     * <p>
     * <b>Subclassing:</b>
     * <br>
     * This method is intended for use by subclasses in implementing their
     * {@link #computeTime computeTime} and/or {@link #computeFields computeFields} methods.
     * It is often useful in {@link #getActualMinimum getActualMinimum} and
     * {@link #getActualMaximum getActualMaximum} as well.
     * <p>
     * This variant is handy for computing the week number of some other
     * day of a period (often the first or last day of the period) when its day
     * of the week is not known but the day number and day of week for some other
     * day in the period (e.g. the current date) <em>is</em> known.
     * <p>
     * @param desiredDay    The {@link #UCalendarDateFields DAY_OF_YEAR} or
     *              {@link #UCalendarDateFields DAY_OF_MONTH} whose week number is desired.
     *              Should be 1 for the first day of the period.
     *
     * @param dayOfPeriod   The {@link #UCalendarDateFields DAY_OF_YEAR}
     *              or {@link #UCalendarDateFields DAY_OF_MONTH} for a day in the period whose
     *              {@link #UCalendarDateFields DAY_OF_WEEK} is specified by the
     *              <code>knownDayOfWeek</code> parameter.
     *              Should be 1 for first day of period.
     *
     * @param dayOfWeek  The {@link #UCalendarDateFields DAY_OF_WEEK} for the day
     *              corresponding to the <code>knownDayOfPeriod</code> parameter.
     *              1-based with 1=Sunday.
     *
     * @return      The week number (one-based), or zero if the day falls before
     *              the first week because
     *              {@link #getMinimalDaysInFirstWeek getMinimalDaysInFirstWeek}
     *              is more than one.
     *
     * @stable ICU 2.8
     */
    U_I18N_API int32_t weekNumber(int32_t desiredDay, int32_t dayOfPeriod, int32_t dayOfWeek);

#ifndef U_HIDE_INTERNAL_API
    /**
     * Return the week number of a day, within a period. This may be the week number in
     * a year, or the week number in a month. Usually this will be a value >= 1, but if
     * some initial days of the period are excluded from week 1, because
     * {@link #getMinimalDaysInFirstWeek getMinimalDaysInFirstWeek} is > 1,
     * then the week number will be zero for those
     * initial days. This method requires the day of week for the given date in order to
     * determine the result.
     * <p>
     * <b>Subclassing:</b>
     * <br>
     * This method is intended for use by subclasses in implementing their
     * {@link #computeTime computeTime} and/or {@link #computeFields computeFields} methods.
     * It is often useful in {@link #getActualMinimum getActualMinimum} and
     * {@link #getActualMaximum getActualMaximum} as well.
     * <p>
     * @param dayOfPeriod   The {@link #UCalendarDateFields DAY_OF_YEAR} or
     *                      {@link #UCalendarDateFields DAY_OF_MONTH} whose week number is desired.
     *                      Should be 1 for the first day of the period.
     *
     * @param dayOfWeek     The {@link #UCalendarDateFields DAY_OF_WEEK} for the day
     *                      corresponding to the <code>dayOfPeriod</code> parameter.
     *                      1-based with 1=Sunday.
     *
     * @return      The week number (one-based), or zero if the day falls before
     *              the first week because
     *              {@link #getMinimalDaysInFirstWeek getMinimalDaysInFirstWeek}
     *              is more than one.
     * @internal
     */
    U_I18N_API inline int32_t weekNumber(int32_t dayOfPeriod, int32_t dayOfWeek);

    /**
     * returns the local DOW, valid range 0..6
     * @internal
     */
    U_I18N_API int32_t getLocalDOW(UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

private:

    /**
     * The next available value for fStamp[]
     */
    int8_t fNextStamp = kMinimumUserStamp;

    /**
     * Recalculates the time stamp array (fStamp).
     * Resets fNextStamp to lowest next stamp value.
     */
    void recalculateStamp();

    /**
     * The current time set for the calendar.
     */
    UDate        fTime = 0;

    /**
     * Time zone affects the time calculation done by Calendar. Calendar subclasses use
     * the time zone data to produce the local time. Always set; never nullptr.
     */
    TimeZone*   fZone = nullptr;

    /**
     * The flag which indicates if the current time is set in the calendar.
     */
    bool      fIsTimeSet:1;

    /**
     * True if the fields are in sync with the currently set time of this Calendar.
     * If false, then the next attempt to get the value of a field will
     * force a recomputation of all fields from the current value of the time
     * field.
     * <P>
     * This should really be named areFieldsInSync, but the old name is retained
     * for backward compatibility.
     */
    bool      fAreFieldsSet:1;

    /**
     * True if all of the fields have been set.  This is initially false, and set to
     * true by computeFields().
     */
    bool      fAreAllFieldsSet:1;

    /**
     * True if all fields have been virtually set, but have not yet been
     * computed.  This occurs only in setTimeInMillis().  A calendar set
     * to this state will compute all fields from the time if it becomes
     * necessary, but otherwise will delay such computation.
     */
    bool      fAreFieldsVirtuallySet:1;

    /**
     * @see   #setLenient
     */
    bool      fLenient:1;

    /**
     * Option for repeated wall time
     * @see #setRepeatedWallTimeOption
     */
    UCalendarWallTimeOption fRepeatedWallTime:3; // Somehow MSVC need 3 bits for UCalendarWallTimeOption

    /**
     * Option for skipped wall time
     * @see #setSkippedWallTimeOption
     */
    UCalendarWallTimeOption fSkippedWallTime:3; // Somehow MSVC need 3 bits for UCalendarWallTimeOption

    /**
     * Both firstDayOfWeek and minimalDaysInFirstWeek are locale-dependent. They are
     * used to figure out the week count for a specific date for a given locale. These
     * must be set when a Calendar is constructed. For example, in US locale,
     * firstDayOfWeek is SUNDAY; minimalDaysInFirstWeek is 1. They are used to figure
     * out the week count for a specific date for a given locale. These must be set when
     * a Calendar is constructed.
     */
    UCalendarDaysOfWeek fFirstDayOfWeek:4; // Somehow MSVC need 4 bits for
                                           // UCalendarDaysOfWeek
    UCalendarDaysOfWeek fWeekendOnset:4; // Somehow MSVC need 4 bits for
                                         // UCalendarDaysOfWeek
    UCalendarDaysOfWeek fWeekendCease:4; // Somehow MSVC need 4 bits for
                                         // UCalendarDaysOfWeek
    uint8_t fMinimalDaysInFirstWeek;
    int32_t fWeekendOnsetMillis;
    int32_t fWeekendCeaseMillis;

    /**
     * Sets firstDayOfWeek and minimalDaysInFirstWeek. Called at Calendar construction
     * time.
     *
     * @param desiredLocale  The given locale.
     * @param type           The calendar type identifier, e.g: gregorian, buddhist, etc.
     * @param success        Indicates the status of setting the week count data from
     *                       the resource for the given locale. Returns U_ZERO_ERROR if
     *                       constructed successfully.
     */
    void        setWeekData(const Locale& desiredLocale, const char *type, UErrorCode& success);

    /**
     * Recompute the time and update the status fields isTimeSet
     * and areFieldsSet.  Callers should check isTimeSet and only
     * call this method if isTimeSet is false.
     *
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid or restricted by
     *                leniency, this will be set to an error status.
     */
    void updateTime(UErrorCode& status);

    /**
     * The Gregorian year, as computed by computeGregorianFields() and
     * returned by getGregorianYear().
     * @see #computeGregorianFields
     */
    int32_t fGregorianYear;

    /**
     * The Gregorian month, as computed by computeGregorianFields() and
     * returned by getGregorianMonth().
     * @see #computeGregorianFields
     */
    int8_t fGregorianMonth;

    /**
     * The Gregorian day of the month, as computed by
     * computeGregorianFields() and returned by getGregorianDayOfMonth().
     * @see #computeGregorianFields
     */
    int8_t fGregorianDayOfMonth;

    /**
     * The Gregorian day of the year, as computed by
     * computeGregorianFields() and returned by getGregorianDayOfYear().
     * @see #computeGregorianFields
     */
    int16_t fGregorianDayOfYear;

    /* calculations */

protected:

    /**
     * Compute the Gregorian calendar year, month, and day of month from the
     * Julian day.  These values are not stored in fields, but in member
     * variables gregorianXxx.  They are used for time zone computations and by
     * subclasses that are Gregorian derivatives.  Subclasses may call this
     * method to perform a Gregorian calendar millis->fields computation.
     */
    U_I18N_API void computeGregorianFields(int32_t julianDay, UErrorCode& ec);

private:

    /**
     * Compute the fields WEEK_OF_YEAR, YEAR_WOY, WEEK_OF_MONTH,
     * DAY_OF_WEEK_IN_MONTH, and DOW_LOCAL from EXTENDED_YEAR, YEAR,
     * DAY_OF_WEEK, and DAY_OF_YEAR.  The latter fields are computed by the
     * subclass based on the calendar system.
     *
     * <p>The YEAR_WOY field is computed simplistically.  It is equal to YEAR
     * most of the time, but at the year boundary it may be adjusted to YEAR-1
     * or YEAR+1 to reflect the overlap of a week into an adjacent year.  In
     * this case, a simple increment or decrement is performed on YEAR, even
     * though this may yield an invalid YEAR value.  For instance, if the YEAR
     * is part of a calendar system with an N-year cycle field CYCLE, then
     * incrementing the YEAR may involve incrementing CYCLE and setting YEAR
     * back to 0 or 1.  This is not handled by this code, and in fact cannot be
     * simply handled without having subclasses define an entire parallel set of
     * fields for fields larger than or equal to a year.  This additional
     * complexity is not warranted, since the intention of the YEAR_WOY field is
     * to support ISO 8601 notation, so it will typically be used with a
     * proleptic Gregorian calendar, which has no field larger than a year.
     */
    void computeWeekFields(UErrorCode &ec);


    /**
     * Ensure that each field is within its valid range by calling {@link
     * #validateField(int, int&)} on each field that has been set.  This method
     * should only be called if this calendar is not lenient.
     * @see #isLenient
     * @see #validateField(int, int&)
     */
    void validateFields(UErrorCode &status);

    /**
     * Validate a single field of this calendar given its minimum and
     * maximum allowed value.  If the field is out of range,
     * <code>U_ILLEGAL_ARGUMENT_ERROR</code> will be set.  Subclasses may
     * use this method in their implementation of {@link
     * #validateField(int, int&)}.
     */
    void validateField(UCalendarDateFields field, int32_t min, int32_t max, UErrorCode& status);

 protected:
#ifndef U_HIDE_INTERNAL_API
    /**
     * Convert a quasi Julian date to the day of the week. The Julian date used here is
     * not a true Julian date, since it is measured from midnight, not noon. Return
     * value is one-based.
     *
     * @param julian  The given Julian date number.
     * @return   Day number from 1..7 (SUN..SAT).
     * @internal
     */
    U_I18N_API static uint8_t julianDayToDayOfWeek(int32_t julian);
#endif  /* U_HIDE_INTERNAL_API */

 private:
    Locale validLocale;
    Locale actualLocale;

 public:
#if !UCONFIG_NO_SERVICE
    /**
     * INTERNAL FOR 2.6 --  Registration.
     */

#ifndef U_HIDE_INTERNAL_API
    /**
     * Return a StringEnumeration over the locales available at the time of the call,
     * including registered locales.
     * @return a StringEnumeration over the locales available at the time of the call
     * @internal
     */
    U_I18N_API static StringEnumeration* getAvailableLocales();

    /**
     * Register a new Calendar factory.  The factory will be adopted.
     * INTERNAL in 2.6
     *
     * Because ICU may choose to cache Calendars internally, this must
     * be called at application startup, prior to any calls to
     * Calendar::createInstance to avoid undefined behavior.
     *
     * @param toAdopt the factory instance to be adopted
     * @param status the in/out status code, no special meanings are assigned
     * @return a registry key that can be used to unregister this factory
     * @internal
     */
    U_I18N_API static URegistryKey registerFactory(ICUServiceFactory* toAdopt, UErrorCode& status);

    /**
     * Unregister a previously-registered CalendarFactory using the key returned from the
     * register call.  Key becomes invalid after a successful call and should not be used again.
     * The CalendarFactory corresponding to the key will be deleted.
     * INTERNAL in 2.6
     *
     * Because ICU may choose to cache Calendars internally, this should
     * be called during application shutdown, after all calls to
     * Calendar::createInstance to avoid undefined behavior.
     *
     * @param key the registry key returned by a previous call to registerFactory
     * @param status the in/out status code, no special meanings are assigned
     * @return true if the factory for the key was successfully unregistered
     * @internal
     */
    U_I18N_API static UBool unregister(URegistryKey key, UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Multiple Calendar Implementation
     * @internal
     */
    friend class CalendarFactory;

    /**
     * Multiple Calendar Implementation
     * @internal
     */
    friend class CalendarService;

    /**
     * Multiple Calendar Implementation
     * @internal
     */
    friend class DefaultCalendarFactory;
#endif /* !UCONFIG_NO_SERVICE */

    /**
     * @return true if this calendar has a default century (i.e. 03 -> 2003)
     * @internal
     */
    U_I18N_API virtual UBool haveDefaultCentury() const = 0;

    /**
     * @return the start of the default century, as a UDate
     * @internal
     */
    U_I18N_API virtual UDate defaultCenturyStart() const = 0;

    /**
     * @return the beginning year of the default century, as a year
     * @internal
     */
    U_I18N_API virtual int32_t defaultCenturyStartYear() const = 0;

    /** Get the locale for this calendar object. You can choose between valid and actual locale.
     *  @param type type of the locale we're looking for (valid or actual)
     *  @param status error code for the operation
     *  @return the locale
     *  @stable ICU 2.8
     */
    U_I18N_API Locale getLocale(ULocDataLocaleType type, UErrorCode& status) const;

    /**
     * @return      The related Gregorian year; will be obtained by modifying the value
     *              obtained by get from UCAL_EXTENDED_YEAR field
     * @internal
     */
    U_I18N_API virtual int32_t getRelatedYear(UErrorCode& status) const;

    /**
     * @param year  The related Gregorian year to set; will be modified as necessary then
     *              set in UCAL_EXTENDED_YEAR field
     * @internal
     */
    U_I18N_API virtual void setRelatedYear(int32_t year);

#ifndef U_HIDE_INTERNAL_API
    /** Get the locale for this calendar object. You can choose between valid and actual locale.
     *  @param type type of the locale we're looking for (valid or actual)
     *  @param status error code for the operation
     *  @return the locale
     *  @internal
     */
    U_I18N_API const char* getLocaleID(ULocDataLocaleType type, UErrorCode& status) const;
#endif  /* U_HIDE_INTERNAL_API */

private:
    /**
     * Cast TimeZone used by this object to BasicTimeZone, or nullptr if the TimeZone
     * is not an instance of BasicTimeZone.
     */
    BasicTimeZone* getBasicTimeZone() const;

    /**
     * Find the previous zone transition near the given time.
     * @param base The base time, inclusive
     * @param transitionTime Receives the result time
     * @param status The error status
     * @return true if a transition is found.
     */
    UBool getImmediatePreviousZoneTransition(UDate base, UDate *transitionTime, UErrorCode& status) const;

public:
#ifndef U_HIDE_INTERNAL_API
    /**
     * Creates a new Calendar from a Locale for the cache.
     * This method does not set the time or timezone in returned calendar.
     * @param locale the locale.
     * @param status any error returned here.
     * @return the new Calendar object with no time or timezone set.
     * @internal For ICU use only.
     */
    U_I18N_API static Calendar* U_EXPORT2 makeInstance(const Locale& locale, UErrorCode& status);

    /**
     * Get the calendar type for given locale.
     * @param locale the locale
     * @param typeBuffer calendar type returned here
     * @param typeBufferSize The size of typeBuffer in bytes. If the type
     *   can't fit in the buffer, this method sets status to
     *   U_BUFFER_OVERFLOW_ERROR
     * @param status error, if any, returned here.
     * @internal For ICU use only.
     */
    U_I18N_API static void U_EXPORT2 getCalendarTypeFromLocale(const Locale& locale,
                                                               char* typeBuffer,
                                                               int32_t typeBufferSize,
                                                               UErrorCode& status);
#endif  /* U_HIDE_INTERNAL_API */
};

// -------------------------------------

inline Calendar*
Calendar::createInstance(TimeZone* zone, UErrorCode& errorCode)
{
    // since the Locale isn't specified, use the default locale
    return createInstance(zone, Locale::getDefault(), errorCode);
}

// -------------------------------------

inline void
Calendar::roll(UCalendarDateFields field, UBool up, UErrorCode& status)
{
    roll(field, static_cast<int32_t>(up ? +1 : -1), status);
}

#ifndef U_HIDE_DEPRECATED_API
inline void
Calendar::roll(EDateFields field, UBool up, UErrorCode& status)
{
    roll(static_cast<UCalendarDateFields>(field), up, status);
}
#endif  /* U_HIDE_DEPRECATED_API */


// -------------------------------------

/**
 * Fast method for subclasses.  The caller must maintain fUserSetDSTOffset and
 * fUserSetZoneOffset, as well as the isSet[] array.
 */

inline void
Calendar::internalSet(UCalendarDateFields field, int32_t value)
{
    fFields[field] = value;
    fStamp[field] = kInternallySet;
}

/**
 * Macro for the class to declare it override
 * haveDefaultCentury, defaultCenturyStart, and
 * defaultCenturyStartYear functions in this class.
 * @internal
 */
#define DECLARE_OVERRIDE_SYSTEM_DEFAULT_CENTURY \
    virtual UBool haveDefaultCentury() const override; \
    virtual UDate defaultCenturyStart() const override; \
    virtual int32_t defaultCenturyStartYear() const override;

#ifndef U_HIDE_INTERNAL_API
inline int32_t  Calendar::weekNumber(int32_t dayOfPeriod, int32_t dayOfWeek)
{
  return weekNumber(dayOfPeriod, dayOfPeriod, dayOfWeek);
}
#endif  /* U_HIDE_INTERNAL_API */

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _CALENDAR
