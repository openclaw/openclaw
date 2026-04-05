// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
* Copyright (C) 1997-2013, International Business Machines Corporation and others.
* All Rights Reserved.
********************************************************************************
*
* File GREGOCAL.H
*
* Modification History:
*
*   Date        Name        Description
*   04/22/97    aliu        Overhauled header.
*    07/28/98    stephen        Sync with JDK 1.2
*    09/04/98    stephen        Re-sync with JDK 8/31 putback
*    09/14/98    stephen        Changed type of kOneDay, kOneWeek to double.
*                            Fixed bug in roll()
*   10/15/99    aliu        Fixed j31, incorrect WEEK_OF_YEAR computation.
*                           Added documentation of WEEK_OF_YEAR computation.
*   10/15/99    aliu        Fixed j32, cannot set date to Feb 29 2000 AD.
*                           {JDK bug 4210209 4209272}
*   11/07/2003  srl         Update, clean up documentation.
********************************************************************************
*/

#ifndef GREGOCAL_H
#define GREGOCAL_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/calendar.h"

/**
 * \file 
 * \brief C++ API: Concrete class which provides the standard calendar.
 */

U_NAMESPACE_BEGIN

/** 
 * Concrete class which provides the standard calendar used by most of the world.
 * <P>
 * The standard (Gregorian) calendar has 2 eras, BC and AD.
 * <P>
 * This implementation handles a single discontinuity, which corresponds by default to
 * the date the Gregorian calendar was originally instituted (October 15, 1582). Not all
 * countries adopted the Gregorian calendar then, so this cutover date may be changed by
 * the caller.
 * <P>
 * Prior to the institution of the Gregorian Calendar, New Year's Day was March 25. To
 * avoid confusion, this Calendar always uses January 1. A manual adjustment may be made
 * if desired for dates that are prior to the Gregorian changeover and which fall
 * between January 1 and March 24.
 *
 * <p>Values calculated for the <code>WEEK_OF_YEAR</code> field range from 1 to
 * 53.  Week 1 for a year is the first week that contains at least
 * <code>getMinimalDaysInFirstWeek()</code> days from that year.  It thus
 * depends on the values of <code>getMinimalDaysInFirstWeek()</code>,
 * <code>getFirstDayOfWeek()</code>, and the day of the week of January 1.
 * Weeks between week 1 of one year and week 1 of the following year are
 * numbered sequentially from 2 to 52 or 53 (as needed).
 *
 * <p>For example, January 1, 1998 was a Thursday.  If
 * <code>getFirstDayOfWeek()</code> is <code>MONDAY</code> and
 * <code>getMinimalDaysInFirstWeek()</code> is 4 (these are the values
 * reflecting ISO 8601 and many national standards), then week 1 of 1998 starts
 * on December 29, 1997, and ends on January 4, 1998.  If, however,
 * <code>getFirstDayOfWeek()</code> is <code>SUNDAY</code>, then week 1 of 1998
 * starts on January 4, 1998, and ends on January 10, 1998; the first three days
 * of 1998 then are part of week 53 of 1997.
 *
 * <p>Example for using GregorianCalendar:
 * <pre>
 * \code
 *     // get the supported ids for GMT-08:00 (Pacific Standard Time)
 *     UErrorCode success = U_ZERO_ERROR;
 *     const StringEnumeration *ids = TimeZone::createEnumeration(-8 * 60 * 60 * 1000, success);
 *     // if no ids were returned, something is wrong. get out.
 *     if (U_FAILURE(success)) {
 *         return;
 *     }
 *
 *     // begin output
 *     cout << "Current Time" << endl;
 *
 *     // create a Pacific Standard Time time zone
 *     SimpleTimeZone* pdt = new SimpleTimeZone(-8 * 60 * 60 * 1000, ids->unext(nullptr, success)));
 *
 *     // set up rules for daylight savings time
 *     pdt->setStartRule(UCAL_MARCH, 1, UCAL_SUNDAY, 2 * 60 * 60 * 1000);
 *     pdt->setEndRule(UCAL_NOVEMBER, 2, UCAL_SUNDAY, 2 * 60 * 60 * 1000);
 *
 *     // create a GregorianCalendar with the Pacific Daylight time zone
 *     // and the current date and time
 *     Calendar* calendar = new GregorianCalendar( pdt, success );
 *
 *     // print out a bunch of interesting things
 *     cout << "ERA: " << calendar->get( UCAL_ERA, success ) << endl;
 *     cout << "YEAR: " << calendar->get( UCAL_YEAR, success ) << endl;
 *     cout << "MONTH: " << calendar->get( UCAL_MONTH, success ) << endl;
 *     cout << "WEEK_OF_YEAR: " << calendar->get( UCAL_WEEK_OF_YEAR, success ) << endl;
 *     cout << "WEEK_OF_MONTH: " << calendar->get( UCAL_WEEK_OF_MONTH, success ) << endl;
 *     cout << "DATE: " << calendar->get( UCAL_DATE, success ) << endl;
 *     cout << "DAY_OF_MONTH: " << calendar->get( UCAL_DAY_OF_MONTH, success ) << endl;
 *     cout << "DAY_OF_YEAR: " << calendar->get( UCAL_DAY_OF_YEAR, success ) << endl;
 *     cout << "DAY_OF_WEEK: " << calendar->get( UCAL_DAY_OF_WEEK, success ) << endl;
 *     cout << "DAY_OF_WEEK_IN_MONTH: " << calendar->get( UCAL_DAY_OF_WEEK_IN_MONTH, success ) << endl;
 *     cout << "AM_PM: " << calendar->get( UCAL_AM_PM, success ) << endl;
 *     cout << "HOUR: " << calendar->get( UCAL_HOUR, success ) << endl;
 *     cout << "HOUR_OF_DAY: " << calendar->get( UCAL_HOUR_OF_DAY, success ) << endl;
 *     cout << "MINUTE: " << calendar->get( UCAL_MINUTE, success ) << endl;
 *     cout << "SECOND: " << calendar->get( UCAL_SECOND, success ) << endl;
 *     cout << "MILLISECOND: " << calendar->get( UCAL_MILLISECOND, success ) << endl;
 *     cout << "ZONE_OFFSET: " << (calendar->get( UCAL_ZONE_OFFSET, success )/(60*60*1000)) << endl;
 *     cout << "DST_OFFSET: " << (calendar->get( UCAL_DST_OFFSET, success )/(60*60*1000)) << endl;
 *
 *     cout << "Current Time, with hour reset to 3" << endl;
 *     calendar->clear(UCAL_HOUR_OF_DAY); // so doesn't override
 *     calendar->set(UCAL_HOUR, 3);
 *     cout << "ERA: " << calendar->get( UCAL_ERA, success ) << endl;
 *     cout << "YEAR: " << calendar->get( UCAL_YEAR, success ) << endl;
 *     cout << "MONTH: " << calendar->get( UCAL_MONTH, success ) << endl;
 *     cout << "WEEK_OF_YEAR: " << calendar->get( UCAL_WEEK_OF_YEAR, success ) << endl;
 *     cout << "WEEK_OF_MONTH: " << calendar->get( UCAL_WEEK_OF_MONTH, success ) << endl;
 *     cout << "DATE: " << calendar->get( UCAL_DATE, success ) << endl;
 *     cout << "DAY_OF_MONTH: " << calendar->get( UCAL_DAY_OF_MONTH, success ) << endl;
 *     cout << "DAY_OF_YEAR: " << calendar->get( UCAL_DAY_OF_YEAR, success ) << endl;
 *     cout << "DAY_OF_WEEK: " << calendar->get( UCAL_DAY_OF_WEEK, success ) << endl;
 *     cout << "DAY_OF_WEEK_IN_MONTH: " << calendar->get( UCAL_DAY_OF_WEEK_IN_MONTH, success ) << endl;
 *     cout << "AM_PM: " << calendar->get( UCAL_AM_PM, success ) << endl;
 *     cout << "HOUR: " << calendar->get( UCAL_HOUR, success ) << endl;
 *     cout << "HOUR_OF_DAY: " << calendar->get( UCAL_HOUR_OF_DAY, success ) << endl;
 *     cout << "MINUTE: " << calendar->get( UCAL_MINUTE, success ) << endl;
 *     cout << "SECOND: " << calendar->get( UCAL_SECOND, success ) << endl;
 *     cout << "MILLISECOND: " << calendar->get( UCAL_MILLISECOND, success ) << endl;
 *     cout << "ZONE_OFFSET: " << (calendar->get( UCAL_ZONE_OFFSET, success )/(60*60*1000)) << endl; // in hours
 *     cout << "DST_OFFSET: " << (calendar->get( UCAL_DST_OFFSET, success )/(60*60*1000)) << endl; // in hours
 *
 *     if (U_FAILURE(success)) {
 *         cout << "An error occurred. success=" << u_errorName(success) << endl;
 *     }
 *
 *     delete ids;
 *     delete calendar; // also deletes pdt
 * \endcode
 * </pre>
 * @stable ICU 2.0
 */
class U_I18N_API GregorianCalendar: public Calendar {
public:

    /**
     * Useful constants for GregorianCalendar and TimeZone.
     * @stable ICU 2.0
     */
    enum EEras {
        BC,
        AD
    };

    /**
     * Constructs a default GregorianCalendar using the current time in the default time
     * zone with the default locale.
     *
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(UErrorCode& success);

    /**
     * Constructs a GregorianCalendar based on the current time in the given time zone
     * with the default locale. Clients are no longer responsible for deleting the given
     * time zone object after it's adopted.
     *
     * @param zoneToAdopt     The given timezone.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(TimeZone* zoneToAdopt, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar based on the current time in the given time zone
     * with the default locale.
     *
     * @param zone     The given timezone.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(const TimeZone& zone, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar based on the current time in the default time zone
     * with the given locale.
     *
     * @param aLocale  The given locale.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(const Locale& aLocale, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar based on the current time in the given time zone
     * with the given locale. Clients are no longer responsible for deleting the given
     * time zone object after it's adopted.
     *
     * @param zoneToAdopt     The given timezone.
     * @param aLocale  The given locale.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(TimeZone* zoneToAdopt, const Locale& aLocale, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar based on the current time in the given time zone
     * with the given locale.
     *
     * @param zone     The given timezone.
     * @param aLocale  The given locale.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(const TimeZone& zone, const Locale& aLocale, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar with the given AD date set in the default time
     * zone with the default locale.
     *
     * @param year     The value used to set the YEAR time field in the calendar.
     * @param month    The value used to set the MONTH time field in the calendar. Month
     *                 value is 0-based. e.g., 0 for January.
     * @param date     The value used to set the DATE time field in the calendar.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(int32_t year, int32_t month, int32_t date, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar with the given AD date and time set for the
     * default time zone with the default locale.
     *
     * @param year     The value used to set the YEAR time field in the calendar.
     * @param month    The value used to set the MONTH time field in the calendar. Month
     *                 value is 0-based. e.g., 0 for January.
     * @param date     The value used to set the DATE time field in the calendar.
     * @param hour     The value used to set the HOUR_OF_DAY time field in the calendar.
     * @param minute   The value used to set the MINUTE time field in the calendar.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(int32_t year, int32_t month, int32_t date, int32_t hour, int32_t minute, UErrorCode& success);

    /**
     * Constructs a GregorianCalendar with the given AD date and time set for the
     * default time zone with the default locale.
     *
     * @param year     The value used to set the YEAR time field in the calendar.
     * @param month    The value used to set the MONTH time field in the calendar. Month
     *                 value is 0-based. e.g., 0 for January.
     * @param date     The value used to set the DATE time field in the calendar.
     * @param hour     The value used to set the HOUR_OF_DAY time field in the calendar.
     * @param minute   The value used to set the MINUTE time field in the calendar.
     * @param second   The value used to set the SECOND time field in the calendar.
     * @param success  Indicates the status of GregorianCalendar object construction.
     *                 Returns U_ZERO_ERROR if constructed successfully.
     * @stable ICU 2.0
     */
    GregorianCalendar(int32_t year, int32_t month, int32_t date, int32_t hour, int32_t minute, int32_t second, UErrorCode& success);

    /**
     * Destructor
     * @stable ICU 2.0
     */
    virtual ~GregorianCalendar();

    /**
     * Copy constructor
     * @param source    the object to be copied.
     * @stable ICU 2.0
     */
    GregorianCalendar(const GregorianCalendar& source);

    /**
     * Default assignment operator
     * @param right    the object to be copied.
     * @stable ICU 2.0
     */
    GregorianCalendar& operator=(const GregorianCalendar& right);

    /**
     * Create and return a polymorphic copy of this calendar.
     * @return    return a polymorphic copy of this calendar.
     * @stable ICU 2.0
     */
    virtual GregorianCalendar* clone() const override;

    /**
     * Sets the GregorianCalendar change date. This is the point when the switch from
     * Julian dates to Gregorian dates occurred. Default is 00:00:00 local time, October
     * 15, 1582. Previous to this time and date will be Julian dates.
     *
     * @param date     The given Gregorian cutover date.
     * @param success  Output param set to success/failure code on exit.
     * @stable ICU 2.0
     */
    void setGregorianChange(UDate date, UErrorCode& success);

    /**
     * Gets the Gregorian Calendar change date. This is the point when the switch from
     * Julian dates to Gregorian dates occurred. Default is 00:00:00 local time, October
     * 15, 1582. Previous to this time and date will be Julian dates.
     *
     * @return   The Gregorian cutover time for this calendar.
     * @stable ICU 2.0
     */
    UDate getGregorianChange() const;

    /**
     * Return true if the given year is a leap year. Determination of whether a year is
     * a leap year is actually very complicated. We do something crude and mostly
     * correct here, but for a real determination you need a lot of contextual
     * information. For example, in Sweden, the change from Julian to Gregorian happened
     * in a complex way resulting in missed leap years and double leap years between
     * 1700 and 1753. Another example is that after the start of the Julian calendar in
     * 45 B.C., the leap years did not regularize until 8 A.D. This method ignores these
     * quirks, and pays attention only to the Julian onset date and the Gregorian
     * cutover (which can be changed).
     *
     * @param year  The given year.
     * @return      True if the given year is a leap year; false otherwise.
     * @stable ICU 2.0
     */
    UBool isLeapYear(int32_t year) const;

    /**
     * Returns true if the given Calendar object is equivalent to this
     * one.  Calendar override.
     *
     * @param other the Calendar to be compared with this Calendar   
     * @stable ICU 2.4
     */
    virtual UBool isEquivalentTo(const Calendar& other) const override;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * (Overrides Calendar) Rolls up or down by the given amount in the specified field.
     * For more information, see the documentation for Calendar::roll().
     *
     * @param field   The time field.
     * @param amount  Indicates amount to roll.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @deprecated ICU 2.6. Use roll(UCalendarDateFields field, int32_t amount, UErrorCode& status) instead.
     */
    virtual void roll(EDateFields field, int32_t amount, UErrorCode& status) override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * (Overrides Calendar) Rolls up or down by the given amount in the specified field.
     * For more information, see the documentation for Calendar::roll().
     *
     * @param field   The time field.
     * @param amount  Indicates amount to roll.
     * @param status  Output param set to success/failure code on exit. If any value
     *                previously set in the time field is invalid, this will be set to
     *                an error status.
     * @stable ICU 2.6.
     */
    virtual void roll(UCalendarDateFields field, int32_t amount, UErrorCode& status) override;

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Return the minimum value that this field could have, given the current date.
     * For the Gregorian calendar, this is the same as getMinimum() and getGreatestMinimum().
     * @param field    the time field.
     * @return         the minimum value that this field could have, given the current date.
     * @deprecated ICU 2.6. Use getActualMinimum(UCalendarDateFields field) instead.
     */
    int32_t getActualMinimum(EDateFields field) const;

    /**
     * Return the minimum value that this field could have, given the current date.
     * For the Gregorian calendar, this is the same as getMinimum() and getGreatestMinimum().
     * @param field    the time field.
     * @param status
     * @return         the minimum value that this field could have, given the current date.
     * @deprecated ICU 2.6. Use getActualMinimum(UCalendarDateFields field) instead. (Added to ICU 3.0 for signature consistency)
     */
    int32_t getActualMinimum(EDateFields field, UErrorCode& status) const;
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Return the minimum value that this field could have, given the current date.
     * For the Gregorian calendar, this is the same as getMinimum() and getGreatestMinimum().
     * @param field    the time field.
     * @param status   error result.
     * @return         the minimum value that this field could have, given the current date.
     * @stable ICU 3.0
     */
    int32_t getActualMinimum(UCalendarDateFields field, UErrorCode &status) const override;

    /**
     * Return the maximum value that this field could have, given the current date.
     * For example, with the date "Feb 3, 1997" and the DAY_OF_MONTH field, the actual
     * maximum would be 28; for "Feb 3, 1996" it s 29.  Similarly for a Hebrew calendar,
     * for some years the actual maximum for MONTH is 12, and for others 13.
     * @param field    the time field.
     * @param status   returns any errors that may result from this function call.
     * @return         the maximum value that this field could have, given the current date.
     * @stable ICU 2.6
     */
    virtual int32_t getActualMaximum(UCalendarDateFields field, UErrorCode& status) const override;

public:

    /**
     * Override Calendar Returns a unique class ID POLYMORPHICALLY. Pure virtual
     * override. This method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone() methods call
     * this method.
     *
     * @return   The class ID for this object. All objects of a given class have the
     *           same class ID. Objects of other classes have different class IDs.
     * @stable ICU 2.0
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * Return the class ID for this class. This is useful only for comparing to a return
     * value from getDynamicClassID(). For example:
     *
     *      Base* polymorphic_pointer = createPolymorphicObject();
     *      if (polymorphic_pointer->getDynamicClassID() ==
     *          Derived::getStaticClassID()) ...
     *
     * @return   The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns the calendar type name string for this Calendar object.
     * The returned string is the legacy ICU calendar attribute value,
     * for example, "gregorian" or "japanese".
     *
     * For more details see the Calendar::getType() documentation.
     *
     * @return legacy calendar type name string
     * @stable ICU 49
     */
    virtual const char * getType() const override;

 private:
    GregorianCalendar() = delete; // default constructor not implemented

 protected:
    /**
     * Return the ERA.  We need a special method for this because the
     * default ERA is AD, but a zero (unset) ERA is BC.
     * @return    the ERA.
     * @internal
     */
    virtual int32_t internalGetEra() const;

    /**
     * Return the Julian day number of day before the first day of the
     * given month in the given extended year.  Subclasses should override
     * this method to implement their calendar system.
     * @param eyear the extended year
     * @param month the zero-based month, or 0 if useMonth is false
     * @param useMonth if false, compute the day before the first day of
     * the given year, otherwise, compute the day before the first day of
     * the given month
     * @param status Fill-in parameter which receives the status of this operation.
     * @return the Julian day number of the day before the first
     * day of the given month and year
     * @internal
     */
    virtual int64_t handleComputeMonthStart(int32_t eyear, int32_t month,
                                            UBool useMonth, UErrorCode& status) const override;

    /**
     * Subclasses may override this.  This method calls
     * handleGetMonthLength() to obtain the calendar-specific month
     * length.
     * @param bestField which field to use to calculate the date 
     * @param status Fill-in parameter which receives the status of this operation.
     * @return julian day specified by calendar fields.
     * @internal
     */
    virtual int32_t handleComputeJulianDay(UCalendarDateFields bestField, UErrorCode& status) override;

    /**
     * Return the number of days in the given month of the given extended
     * year of this calendar system.  Subclasses should override this
     * method if they can provide a more correct or more efficient
     * implementation than the default implementation in Calendar.
     * @internal
     */
    virtual int32_t handleGetMonthLength(int32_t extendedYear, int32_t month, UErrorCode& status) const override;

    /**
     * Return the number of days in the given extended year of this
     * calendar system.  Subclasses should override this method if they can
     * provide a more correct or more efficient implementation than the
     * default implementation in Calendar.
     * @stable ICU 2.0
     */
    virtual int32_t handleGetYearLength(int32_t eyear, UErrorCode& status) const override;

    /**
     * return the length of the given month.
     * @param month    the given month.
     * @param status Fill-in parameter which receives the status of this operation.
     * @return    the length of the given month.
     * @internal
     */
    virtual int32_t monthLength(int32_t month, UErrorCode& status) const;

    /**
     * return the length of the month according to the given year.
     * @param month    the given month.
     * @param year     the given year.
     * @return         the length of the month
     * @internal
     */
    virtual int32_t monthLength(int32_t month, int32_t year) const;

#ifndef U_HIDE_INTERNAL_API
    /**
     * return the length of the year field.
     * @return    the length of the year field
     * @internal
     */
  int32_t yearLength() const;

#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Return the day number with respect to the epoch.  January 1, 1970 (Gregorian)
     * is day zero.
     * @param status Fill-in parameter which receives the status of this operation.
     * @return       the day number with respect to the epoch.  
     * @internal
     */
    virtual UDate getEpochDay(UErrorCode& status);

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
    virtual int32_t handleGetLimit(UCalendarDateFields field, ELimitType limitType) const override;

    /**
     * Return the extended year defined by the current fields.  This will
     * use the UCAL_EXTENDED_YEAR field or the UCAL_YEAR and supra-year fields (such
     * as UCAL_ERA) specific to the calendar system, depending on which set of
     * fields is newer.
     * @param status
     * @return the extended year
     * @internal
     */
    virtual int32_t handleGetExtendedYear(UErrorCode& status) override;

    /** 
     * Subclasses may override this to convert from week fields 
     * (YEAR_WOY and WEEK_OF_YEAR) to an extended year in the case
     * where YEAR, EXTENDED_YEAR are not set.
     * The Gregorian implementation assumes a yearWoy in gregorian format, according to the current era.
     * @return the extended year, UCAL_EXTENDED_YEAR
     * @internal
     */
    virtual int32_t handleGetExtendedYearFromWeekFields(int32_t yearWoy, int32_t woy, UErrorCode& status) override;


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
     * <p>The GregorianCalendar implementation implements
     * a calendar with the specified Julian/Gregorian cutover date.
     * @internal
     */
    virtual void handleComputeFields(int32_t julianDay, UErrorCode &status) override;

#ifndef U_HIDE_INTERNAL_API
    /**
     * The year in this calendar is counting from 1 backward if the era is 0.
     * @return The year in era 0 of this calendar is counting backward from 1.
     * @internal
     */
    virtual bool isEra0CountingBackward() const override { return true; }
#endif  // U_HIDE_INTERNAL_API

 private:
    /**
     * Compute the julian day number of the given year.
     * @param isGregorian    if true, using Gregorian calendar, otherwise using Julian calendar
     * @param year           the given year.
     * @param isLeap         true if the year is a leap year.       
     * @return 
     */
    static double computeJulianDayOfYear(UBool isGregorian, int32_t year,
                                         UBool& isLeap);
    
    /**
     * Validates the values of the set time fields.  True if they're all valid.
     * @return    True if the set time fields are all valid.
     */
    UBool validateFields() const;

    /**
     * Validates the value of the given time field.  True if it's valid.
     */
    UBool boundsCheck(int32_t value, UCalendarDateFields field) const;

    /**
     * Return the pseudo-time-stamp for two fields, given their
     * individual pseudo-time-stamps.  If either of the fields
     * is unset, then the aggregate is unset.  Otherwise, the
     * aggregate is the later of the two stamps.
     * @param stamp_a    One given field.
     * @param stamp_b    Another given field.
     * @return the pseudo-time-stamp for two fields
     */
    int32_t aggregateStamp(int32_t stamp_a, int32_t stamp_b);

    /**
     * The point at which the Gregorian calendar rules are used, measured in
     * milliseconds from the standard epoch.  Default is October 15, 1582
     * (Gregorian) 00:00:00 UTC, that is, October 4, 1582 (Julian) is followed
     * by October 15, 1582 (Gregorian).  This corresponds to Julian day number
     * 2299161. This is measured from the standard epoch, not in Julian Days.
     */
    UDate                fGregorianCutover;

    /**
     * Julian day number of the Gregorian cutover
     */
    int32_t             fCutoverJulianDay;

    /**
     * The year of the gregorianCutover, with 0 representing
     * 1 BC, -1 representing 2 BC, etc.
     */
    int32_t fGregorianCutoverYear;// = 1582;

    /**
     * Converts time as milliseconds to Julian date. The Julian date used here is not a
     * true Julian date, since it is measured from midnight, not noon.
     *
     * @param millis  The given milliseconds.
     * @return        The Julian date number.
     */
    static double millisToJulianDay(UDate millis);

    /**
     * Converts Julian date to time as milliseconds. The Julian date used here is not a
     * true Julian date, since it is measured from midnight, not noon.
     *
     * @param julian  The given Julian date number.
     * @return        Time as milliseconds.
     */
    static UDate julianDayToMillis(double julian);

    /**
     * Used by handleComputeJulianDay() and handleComputeMonthStart().
     * Temporary field indicating whether the calendar is currently Gregorian as opposed to Julian.
     */
    UBool fIsGregorian;

    /**
     * Used by handleComputeJulianDay() and handleComputeMonthStart().
     * Temporary field indicating that the sense of the gregorian cutover should be inverted
     * to handle certain calculations on and around the cutover date.
     */
    UBool fInvertGregorian;


 public: // internal implementation

    DECLARE_OVERRIDE_SYSTEM_DEFAULT_CENTURY

};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _GREGOCAL
//eof

