// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 ********************************************************************************
 * Copyright (C) 1997-2013, International Business Machines                     *
 * Corporation and others. All Rights Reserved.                                 *
 ********************************************************************************
 *
 * File SIMPLETZ.H
 *
 * Modification History:
 *
 *   Date        Name        Description
 *   04/21/97    aliu        Overhauled header.
 *   08/10/98    stephen     JDK 1.2 sync
 *                           Added setStartRule() / setEndRule() overloads
 *                           Added hasSameRules()
 *   09/02/98    stephen     Added getOffset(monthLen)
 *                           Changed getOffset() to take UErrorCode
 *   07/09/99    stephen     Removed millisPerHour (unused, for HP compiler)
 *   12/02/99    aliu        Added TimeMode and constructor and setStart/EndRule
 *                           methods that take TimeMode. Added to docs.
 ********************************************************************************
 */

#ifndef SIMPLETZ_H
#define SIMPLETZ_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: SimpleTimeZone is a concrete subclass of TimeZone.
 */
 
#if !UCONFIG_NO_FORMATTING

#include "unicode/basictz.h"

U_NAMESPACE_BEGIN

// forward declaration
class InitialTimeZoneRule;
class TimeZoneTransition;
class AnnualTimeZoneRule;

/**
 * <code>SimpleTimeZone</code> is a concrete subclass of <code>TimeZone</code>
 * that represents a time zone for use with a Gregorian calendar. This
 * class does not handle historical changes.
 * <P>
 * When specifying daylight-savings-time begin and end dates, use a negative value for
 * <code>dayOfWeekInMonth</code> to indicate that <code>SimpleTimeZone</code> should
 * count from the end of the month backwards. For example, if Daylight Savings
 * Time starts or ends at the last Sunday a month, use <code>dayOfWeekInMonth = -1</code>
 * along with <code>dayOfWeek = UCAL_SUNDAY</code> to specify the rule.
 *
 * @see      Calendar
 * @see      GregorianCalendar
 * @see      TimeZone
 * @author   D. Goldsmith, Mark Davis, Chen-Lieh Huang, Alan Liu
 */
class U_I18N_API SimpleTimeZone: public BasicTimeZone {
public:

    /**
     * TimeMode is used, together with a millisecond offset after
     * midnight, to specify a rule transition time.  Most rules
     * transition at a local wall time, that is, according to the
     * current time in effect, either standard, or DST.  However, some
     * rules transition at local standard time, and some at a specific
     * UTC time.  Although it might seem that all times could be
     * converted to wall time, thus eliminating the need for this
     * parameter, this is not the case.
     * @stable ICU 2.0
     */
    enum TimeMode {
        WALL_TIME = 0,
        STANDARD_TIME,
        UTC_TIME
    };

    /**
     * Copy constructor
     * @param source the object to be copied.
     * @stable ICU 2.0
     */
    SimpleTimeZone(const SimpleTimeZone& source);

    /**
     * Default assignment operator
     * @param right    the object to be copied.
     * @stable ICU 2.0
     */
    SimpleTimeZone& operator=(const SimpleTimeZone& right);

    /**
     * Destructor
     * @stable ICU 2.0
     */
    virtual ~SimpleTimeZone();

    /**
     * Returns true if the two TimeZone objects are equal; that is, they have
     * the same ID, raw GMT offset, and DST rules.
     *
     * @param that  The SimpleTimeZone object to be compared with.
     * @return      true if the given time zone is equal to this time zone; false
     *              otherwise.
     * @stable ICU 2.0
     */
    virtual bool operator==(const TimeZone& that) const override;

    /**
     * Constructs a SimpleTimeZone with the given raw GMT offset and time zone ID,
     * and which doesn't observe daylight savings time.  Normally you should use
     * TimeZone::createInstance() to create a TimeZone instead of creating a
     * SimpleTimeZone directly with this constructor.
     *
     * @param rawOffsetGMT  The given base time zone offset to GMT.
     * @param ID         The timezone ID which is obtained from
     *                   TimeZone.getAvailableIDs.
     * @stable ICU 2.0
     */
    SimpleTimeZone(int32_t rawOffsetGMT, const UnicodeString& ID);

    /**
     * Construct a SimpleTimeZone with the given raw GMT offset, time zone ID,
     * and times to start and end daylight savings time. To create a TimeZone that
     * doesn't observe daylight savings time, don't use this constructor; use
     * SimpleTimeZone(rawOffset, ID) instead. Normally, you should use
     * TimeZone.createInstance() to create a TimeZone instead of creating a
     * SimpleTimeZone directly with this constructor.
     * <P>
     * Various types of daylight-savings time rules can be specified by using different
     * values for startDay and startDayOfWeek and endDay and endDayOfWeek.  For a
     * complete explanation of how these parameters work, see the documentation for
     * setStartRule().
     *
     * @param rawOffsetGMT      The new SimpleTimeZone's raw GMT offset
     * @param ID                The new SimpleTimeZone's time zone ID.
     * @param savingsStartMonth The daylight savings starting month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsStartDayOfWeekInMonth   The daylight savings starting
     *                          day-of-week-in-month. See setStartRule() for a
     *                          complete explanation.
     * @param savingsStartDayOfWeek The daylight savings starting day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsStartTime  The daylight savings starting time, expressed as the
     *                          number of milliseconds after midnight.
     * @param savingsEndMonth   The daylight savings ending month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsEndDayOfWeekInMonth     The daylight savings ending day-of-week-in-month.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndDayOfWeek The daylight savings ending day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndTime    The daylight savings ending time, expressed as the
     *                          number of milliseconds after midnight.
     * @param status            An UErrorCode to receive the status.
     * @stable ICU 2.0
     */
    SimpleTimeZone(int32_t rawOffsetGMT, const UnicodeString& ID,
        int8_t savingsStartMonth, int8_t savingsStartDayOfWeekInMonth,
        int8_t savingsStartDayOfWeek, int32_t savingsStartTime,
        int8_t savingsEndMonth, int8_t savingsEndDayOfWeekInMonth,
        int8_t savingsEndDayOfWeek, int32_t savingsEndTime,
        UErrorCode& status);
    /**
     * Construct a SimpleTimeZone with the given raw GMT offset, time zone ID,
     * and times to start and end daylight savings time. To create a TimeZone that
     * doesn't observe daylight savings time, don't use this constructor; use
     * SimpleTimeZone(rawOffset, ID) instead. Normally, you should use
     * TimeZone.createInstance() to create a TimeZone instead of creating a
     * SimpleTimeZone directly with this constructor.
     * <P>
     * Various types of daylight-savings time rules can be specified by using different
     * values for startDay and startDayOfWeek and endDay and endDayOfWeek.  For a
     * complete explanation of how these parameters work, see the documentation for
     * setStartRule().
     *
     * @param rawOffsetGMT      The new SimpleTimeZone's raw GMT offset
     * @param ID                The new SimpleTimeZone's time zone ID.
     * @param savingsStartMonth The daylight savings starting month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsStartDayOfWeekInMonth   The daylight savings starting
     *                          day-of-week-in-month. See setStartRule() for a
     *                          complete explanation.
     * @param savingsStartDayOfWeek The daylight savings starting day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsStartTime  The daylight savings starting time, expressed as the
     *                          number of milliseconds after midnight.
     * @param savingsEndMonth   The daylight savings ending month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsEndDayOfWeekInMonth     The daylight savings ending day-of-week-in-month.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndDayOfWeek The daylight savings ending day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndTime    The daylight savings ending time, expressed as the
     *                          number of milliseconds after midnight.
     * @param savingsDST        The number of milliseconds added to standard time
     *                          to get DST time. Default is one hour.
     * @param status            An UErrorCode to receive the status.
     * @stable ICU 2.0
     */
    SimpleTimeZone(int32_t rawOffsetGMT, const UnicodeString& ID,
        int8_t savingsStartMonth, int8_t savingsStartDayOfWeekInMonth,
        int8_t savingsStartDayOfWeek, int32_t savingsStartTime,
        int8_t savingsEndMonth, int8_t savingsEndDayOfWeekInMonth,
        int8_t savingsEndDayOfWeek, int32_t savingsEndTime,
        int32_t savingsDST, UErrorCode& status);

    /**
     * Construct a SimpleTimeZone with the given raw GMT offset, time zone ID,
     * and times to start and end daylight savings time. To create a TimeZone that
     * doesn't observe daylight savings time, don't use this constructor; use
     * SimpleTimeZone(rawOffset, ID) instead. Normally, you should use
     * TimeZone.createInstance() to create a TimeZone instead of creating a
     * SimpleTimeZone directly with this constructor.
     * <P>
     * Various types of daylight-savings time rules can be specified by using different
     * values for startDay and startDayOfWeek and endDay and endDayOfWeek.  For a
     * complete explanation of how these parameters work, see the documentation for
     * setStartRule().
     *
     * @param rawOffsetGMT      The new SimpleTimeZone's raw GMT offset
     * @param ID                The new SimpleTimeZone's time zone ID.
     * @param savingsStartMonth The daylight savings starting month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsStartDayOfWeekInMonth   The daylight savings starting
     *                          day-of-week-in-month. See setStartRule() for a
     *                          complete explanation.
     * @param savingsStartDayOfWeek The daylight savings starting day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsStartTime  The daylight savings starting time, expressed as the
     *                          number of milliseconds after midnight.
     * @param savingsStartTimeMode Whether the start time is local wall time, local
     *                          standard time, or UTC time. Default is local wall time.
     * @param savingsEndMonth   The daylight savings ending month. Month is
     *                          0-based. eg, 0 for January.
     * @param savingsEndDayOfWeekInMonth     The daylight savings ending day-of-week-in-month.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndDayOfWeek The daylight savings ending day-of-week.
     *                          See setStartRule() for a complete explanation.
     * @param savingsEndTime    The daylight savings ending time, expressed as the
     *                          number of milliseconds after midnight.
     * @param savingsEndTimeMode Whether the end time is local wall time, local
     *                          standard time, or UTC time. Default is local wall time.
     * @param savingsDST        The number of milliseconds added to standard time
     *                          to get DST time. Default is one hour.
     * @param status            An UErrorCode to receive the status.
     * @stable ICU 2.0
     */
    SimpleTimeZone(int32_t rawOffsetGMT, const UnicodeString& ID,
        int8_t savingsStartMonth, int8_t savingsStartDayOfWeekInMonth,
        int8_t savingsStartDayOfWeek, int32_t savingsStartTime,
        TimeMode savingsStartTimeMode,
        int8_t savingsEndMonth, int8_t savingsEndDayOfWeekInMonth,
        int8_t savingsEndDayOfWeek, int32_t savingsEndTime, TimeMode savingsEndTimeMode,
        int32_t savingsDST, UErrorCode& status);

    /**
     * Sets the daylight savings starting year, that is, the year this time zone began
     * observing its specified daylight savings time rules.  The time zone is considered
     * not to observe daylight savings time prior to that year; SimpleTimeZone doesn't
     * support historical daylight-savings-time rules.
     * @param year the daylight savings starting year.
     * @stable ICU 2.0
     */
    void setStartYear(int32_t year);

    /**
     * Sets the daylight savings starting rule. For example, in the U.S., Daylight Savings
     * Time starts at the second Sunday in March, at 2 AM in standard time.
     * Therefore, you can set the start rule by calling:
     * setStartRule(UCAL_MARCH, 2, UCAL_SUNDAY, 2*60*60*1000);
     * The dayOfWeekInMonth and dayOfWeek parameters together specify how to calculate
     * the exact starting date.  Their exact meaning depend on their respective signs,
     * allowing various types of rules to be constructed, as follows:
     * <ul>
     *   <li>If both dayOfWeekInMonth and dayOfWeek are positive, they specify the
     *       day of week in the month (e.g., (2, WEDNESDAY) is the second Wednesday
     *       of the month).</li>
     *   <li>If dayOfWeek is positive and dayOfWeekInMonth is negative, they specify
     *       the day of week in the month counting backward from the end of the month.
     *       (e.g., (-1, MONDAY) is the last Monday in the month)</li>
     *   <li>If dayOfWeek is zero and dayOfWeekInMonth is positive, dayOfWeekInMonth
     *       specifies the day of the month, regardless of what day of the week it is.
     *       (e.g., (10, 0) is the tenth day of the month)</li>
     *   <li>If dayOfWeek is zero and dayOfWeekInMonth is negative, dayOfWeekInMonth
     *       specifies the day of the month counting backward from the end of the
     *       month, regardless of what day of the week it is (e.g., (-2, 0) is the
     *       next-to-last day of the month).</li>
     *   <li>If dayOfWeek is negative and dayOfWeekInMonth is positive, they specify the
     *       first specified day of the week on or after the specified day of the month.
     *       (e.g., (15, -SUNDAY) is the first Sunday after the 15th of the month
     *       [or the 15th itself if the 15th is a Sunday].)</li>
     *   <li>If dayOfWeek and DayOfWeekInMonth are both negative, they specify the
     *       last specified day of the week on or before the specified day of the month.
     *       (e.g., (-20, -TUESDAY) is the last Tuesday before the 20th of the month
     *       [or the 20th itself if the 20th is a Tuesday].)</li>
     * </ul>
     * @param month the daylight savings starting month. Month is 0-based.
     * eg, 0 for January.
     * @param dayOfWeekInMonth the daylight savings starting
     * day-of-week-in-month. Please see the member description for an example.
     * @param dayOfWeek the daylight savings starting day-of-week. Please see
     * the member description for an example.
     * @param time the daylight savings starting time. Please see the member
     * description for an example.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfWeekInMonth, int32_t dayOfWeek,
                      int32_t time, UErrorCode& status);
    /**
     * Sets the daylight savings starting rule. For example, in the U.S., Daylight Savings
     * Time starts at the second Sunday in March, at 2 AM in standard time.
     * Therefore, you can set the start rule by calling:
     * setStartRule(UCAL_MARCH, 2, UCAL_SUNDAY, 2*60*60*1000);
     * The dayOfWeekInMonth and dayOfWeek parameters together specify how to calculate
     * the exact starting date.  Their exact meaning depend on their respective signs,
     * allowing various types of rules to be constructed, as follows:
     * <ul>
     *   <li>If both dayOfWeekInMonth and dayOfWeek are positive, they specify the
     *       day of week in the month (e.g., (2, WEDNESDAY) is the second Wednesday
     *       of the month).</li>
     *   <li>If dayOfWeek is positive and dayOfWeekInMonth is negative, they specify
     *       the day of week in the month counting backward from the end of the month.
     *       (e.g., (-1, MONDAY) is the last Monday in the month)</li>
     *   <li>If dayOfWeek is zero and dayOfWeekInMonth is positive, dayOfWeekInMonth
     *       specifies the day of the month, regardless of what day of the week it is.
     *       (e.g., (10, 0) is the tenth day of the month)</li>
     *   <li>If dayOfWeek is zero and dayOfWeekInMonth is negative, dayOfWeekInMonth
     *       specifies the day of the month counting backward from the end of the
     *       month, regardless of what day of the week it is (e.g., (-2, 0) is the
     *       next-to-last day of the month).</li>
     *   <li>If dayOfWeek is negative and dayOfWeekInMonth is positive, they specify the
     *       first specified day of the week on or after the specified day of the month.
     *       (e.g., (15, -SUNDAY) is the first Sunday after the 15th of the month
     *       [or the 15th itself if the 15th is a Sunday].)</li>
     *   <li>If dayOfWeek and DayOfWeekInMonth are both negative, they specify the
     *       last specified day of the week on or before the specified day of the month.
     *       (e.g., (-20, -TUESDAY) is the last Tuesday before the 20th of the month
     *       [or the 20th itself if the 20th is a Tuesday].)</li>
     * </ul>
     * @param month the daylight savings starting month. Month is 0-based.
     * eg, 0 for January.
     * @param dayOfWeekInMonth the daylight savings starting
     * day-of-week-in-month. Please see the member description for an example.
     * @param dayOfWeek the daylight savings starting day-of-week. Please see
     * the member description for an example.
     * @param time the daylight savings starting time. Please see the member
     * description for an example.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfWeekInMonth, int32_t dayOfWeek,
                      int32_t time, TimeMode mode, UErrorCode& status);

    /**
     * Sets the DST start rule to a fixed date within a month.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    The date in that month (1-based).
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST takes effect in local wall time, which is
     *                      standard time in this case.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfMonth, int32_t time,
                      UErrorCode& status);
    /**
     * Sets the DST start rule to a fixed date within a month.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    The date in that month (1-based).
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST takes effect in local wall time, which is
     *                      standard time in this case.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfMonth, int32_t time,
                      TimeMode mode, UErrorCode& status);

    /**
     * Sets the DST start rule to a weekday before or after a give date within
     * a month, e.g., the first Monday on or after the 8th.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    A date within that month (1-based).
     * @param dayOfWeek     The day of the week on which this rule occurs.
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST takes effect in local wall time, which is
     *                      standard time in this case.
     * @param after         If true, this rule selects the first dayOfWeek on
     *                      or after dayOfMonth.  If false, this rule selects
     *                      the last dayOfWeek on or before dayOfMonth.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek,
                      int32_t time, UBool after, UErrorCode& status);
    /**
     * Sets the DST start rule to a weekday before or after a give date within
     * a month, e.g., the first Monday on or after the 8th.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    A date within that month (1-based).
     * @param dayOfWeek     The day of the week on which this rule occurs.
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST takes effect in local wall time, which is
     *                      standard time in this case.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param after         If true, this rule selects the first dayOfWeek on
     *                      or after dayOfMonth.  If false, this rule selects
     *                      the last dayOfWeek on or before dayOfMonth.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setStartRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek,
                      int32_t time, TimeMode mode, UBool after, UErrorCode& status);

    /**
     * Sets the daylight savings ending rule. For example, if Daylight
     * Savings Time ends at the last (-1) Sunday in October, at 2 AM in standard time.
     * Therefore, you can set the end rule by calling:
     * <pre>
     *    setEndRule(UCAL_OCTOBER, -1, UCAL_SUNDAY, 2*60*60*1000);
     * </pre>
     * Various other types of rules can be specified by manipulating the dayOfWeek
     * and dayOfWeekInMonth parameters.  For complete details, see the documentation
     * for setStartRule().
     *
     * @param month the daylight savings ending month. Month is 0-based.
     * eg, 0 for January.
     * @param dayOfWeekInMonth the daylight savings ending
     * day-of-week-in-month. See setStartRule() for a complete explanation.
     * @param dayOfWeek the daylight savings ending day-of-week. See setStartRule()
     * for a complete explanation.
     * @param time the daylight savings ending time. Please see the member
     * description for an example.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfWeekInMonth, int32_t dayOfWeek,
                    int32_t time, UErrorCode& status);

    /**
     * Sets the daylight savings ending rule. For example, if Daylight
     * Savings Time ends at the last (-1) Sunday in October, at 2 AM in standard time.
     * Therefore, you can set the end rule by calling:
     * <pre>
     *    setEndRule(UCAL_OCTOBER, -1, UCAL_SUNDAY, 2*60*60*1000);
     * </pre>
     * Various other types of rules can be specified by manipulating the dayOfWeek
     * and dayOfWeekInMonth parameters.  For complete details, see the documentation
     * for setStartRule().
     *
     * @param month the daylight savings ending month. Month is 0-based.
     * eg, 0 for January.
     * @param dayOfWeekInMonth the daylight savings ending
     * day-of-week-in-month. See setStartRule() for a complete explanation.
     * @param dayOfWeek the daylight savings ending day-of-week. See setStartRule()
     * for a complete explanation.
     * @param time the daylight savings ending time. Please see the member
     * description for an example.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfWeekInMonth, int32_t dayOfWeek,
                    int32_t time, TimeMode mode, UErrorCode& status);

    /**
     * Sets the DST end rule to a fixed date within a month.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    The date in that month (1-based).
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST ends in local wall time, which is daylight
     *                      time in this case.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfMonth, int32_t time, UErrorCode& status);

    /**
     * Sets the DST end rule to a fixed date within a month.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    The date in that month (1-based).
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST ends in local wall time, which is daylight
     *                      time in this case.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfMonth, int32_t time,
                    TimeMode mode, UErrorCode& status);

    /**
     * Sets the DST end rule to a weekday before or after a give date within
     * a month, e.g., the first Monday on or after the 8th.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    A date within that month (1-based).
     * @param dayOfWeek     The day of the week on which this rule occurs.
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST ends in local wall time, which is daylight
     *                      time in this case.
     * @param after         If true, this rule selects the first dayOfWeek on
     *                      or after dayOfMonth.  If false, this rule selects
     *                      the last dayOfWeek on or before dayOfMonth.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek,
                    int32_t time, UBool after, UErrorCode& status);

    /**
     * Sets the DST end rule to a weekday before or after a give date within
     * a month, e.g., the first Monday on or after the 8th.
     *
     * @param month         The month in which this rule occurs (0-based).
     * @param dayOfMonth    A date within that month (1-based).
     * @param dayOfWeek     The day of the week on which this rule occurs.
     * @param time          The time of that day (number of millis after midnight)
     *                      when DST ends in local wall time, which is daylight
     *                      time in this case.
     * @param mode whether the time is local wall time, local standard time,
     * or UTC time. Default is local wall time.
     * @param after         If true, this rule selects the first dayOfWeek on
     *                      or after dayOfMonth.  If false, this rule selects
     *                      the last dayOfWeek on or before dayOfMonth.
     * @param status An UErrorCode
     * @stable ICU 2.0
     */
    void setEndRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek,
                    int32_t time, TimeMode mode, UBool after, UErrorCode& status);

    /**
     * Returns the TimeZone's adjusted GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time in this time zone, taking daylight savings time into
     * account) as of a particular reference date.  The reference date is used to determine
     * whether daylight savings time is in effect and needs to be figured into the offset
     * that is returned (in other words, what is the adjusted GMT offset in this time zone
     * at this particular date and time?).  For the time zones produced by createTimeZone(),
     * the reference data is specified according to the Gregorian calendar, and the date
     * and time fields are in GMT, NOT local time.
     *
     * @param era        The reference date's era
     * @param year       The reference date's year
     * @param month      The reference date's month (0-based; 0 is January)
     * @param day        The reference date's day-in-month (1-based)
     * @param dayOfWeek  The reference date's day-of-week (1-based; 1 is Sunday)
     * @param millis     The reference date's milliseconds in day, UTT (NOT local time).
     * @param status     An UErrorCode to receive the status.
     * @return           The offset in milliseconds to add to GMT to get local time.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                              uint8_t dayOfWeek, int32_t millis, UErrorCode& status) const override;

    /**
     * Gets the time zone offset, for current date, modified in case of
     * daylight savings. This is the offset to add *to* UTC to get local time.
     * @param era the era of the given date.
     * @param year the year in the given date.
     * @param month the month in the given date.
     * Month is 0-based. e.g., 0 for January.
     * @param day the day-in-month of the given date.
     * @param dayOfWeek the day-of-week of the given date.
     * @param milliseconds the millis in day in <em>standard</em> local time.
     * @param monthLength the length of the given month in days.
     * @param status     An UErrorCode to receive the status.
     * @return the offset to add *to* GMT to get local time.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                           uint8_t dayOfWeek, int32_t milliseconds,
                           int32_t monthLength, UErrorCode& status) const override;
    /**
     * Gets the time zone offset, for current date, modified in case of
     * daylight savings. This is the offset to add *to* UTC to get local time.
     * @param era the era of the given date.
     * @param year the year in the given date.
     * @param month the month in the given date.
     * Month is 0-based. e.g., 0 for January.
     * @param day the day-in-month of the given date.
     * @param dayOfWeek the day-of-week of the given date.
     * @param milliseconds the millis in day in <em>standard</em> local time.
     * @param monthLength the length of the given month in days.
     * @param prevMonthLength length of the previous month in days.
     * @param status     An UErrorCode to receive the status.
     * @return the offset to add *to* GMT to get local time.
     * @stable ICU 2.0
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                              uint8_t dayOfWeek, int32_t milliseconds,
                              int32_t monthLength, int32_t prevMonthLength,
                              UErrorCode& status) const;

    /**
     * Redeclared TimeZone method.  This implementation simply calls
     * the base class method, which otherwise would be hidden.
     * @stable ICU 2.8
     */
    virtual void getOffset(UDate date, UBool local, int32_t& rawOffset,
                           int32_t& dstOffset, UErrorCode& ec) const override;

    /**
     * Get time zone offsets from local wall time.
     * @stable ICU 69
     */
    virtual void getOffsetFromLocal(
        UDate date, UTimeZoneLocalOption nonExistingTimeOpt,
        UTimeZoneLocalOption duplicatedTimeOpt,
        int32_t& rawOffset, int32_t& dstOffset, UErrorCode& status) const override;

    /**
     * Returns the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @return   The TimeZone's raw GMT offset.
     * @stable ICU 2.0
     */
    virtual int32_t getRawOffset() const override;

    /**
     * Sets the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @param offsetMillis  The new raw GMT offset for this time zone.
     * @stable ICU 2.0
     */
    virtual void setRawOffset(int32_t offsetMillis) override;

    /**
     * Sets the amount of time in ms that the clock is advanced during DST.
     * @param millisSavedDuringDST the number of milliseconds the time is
     * advanced with respect to standard time when the daylight savings rules
     * are in effect. Typically one hour (+3600000). The amount could be negative,
     * but not 0.
     * @param status  An UErrorCode to receive the status.
     * @stable ICU 2.0
     */
    void setDSTSavings(int32_t millisSavedDuringDST, UErrorCode& status);

    /**
     * Returns the amount of time in ms that the clock is advanced during DST.
     * @return the number of milliseconds the time is
     * advanced with respect to standard time when the daylight savings rules
     * are in effect. Typically one hour (+3600000). The amount could be negative,
     * but not 0.
     * @stable ICU 2.0
     */
    virtual int32_t getDSTSavings() const override;

    /**
     * Queries if this TimeZone uses Daylight Savings Time.
     *
     * @return   True if this TimeZone uses Daylight Savings Time; false otherwise.
     * @stable ICU 2.0
     */
    virtual UBool useDaylightTime() const override;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Returns true if the given date is within the period when daylight savings time
     * is in effect; false otherwise.  If the TimeZone doesn't observe daylight savings
     * time, this functions always returns false.
     * This method is wasteful since it creates a new GregorianCalendar and
     * deletes it each time it is called. This is a deprecated method
     * and provided only for Java compatibility.
     *
     * @param date The date to test.
     * @param status  An UErrorCode to receive the status.
     * @return true if the given date is in Daylight Savings Time;
     * false otherwise.
     * @deprecated ICU 2.4. Use Calendar::inDaylightTime() instead.
     */
    virtual UBool inDaylightTime(UDate date, UErrorCode& status) const override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Return true if this zone has the same rules and offset as another zone.
     * @param other the TimeZone object to be compared with
     * @return true if the given zone has the same rules and offset as this one
     * @stable ICU 2.0
     */
    UBool hasSameRules(const TimeZone& other) const override;

    /**
     * Clones TimeZone objects polymorphically. Clients are responsible for deleting
     * the TimeZone object cloned.
     *
     * @return   A new copy of this TimeZone object.
     * @stable ICU 2.0
     */
    virtual SimpleTimeZone* clone() const override;

    /**
     * Gets the first time zone transition after the base time.
     * @param base      The base time.
     * @param inclusive Whether the base time is inclusive or not.
     * @param result    Receives the first transition after the base time.
     * @return  true if the transition is found.
     * @stable ICU 3.8
     */
    virtual UBool getNextTransition(UDate base, UBool inclusive, TimeZoneTransition& result) const override;

    /**
     * Gets the most recent time zone transition before the base time.
     * @param base      The base time.
     * @param inclusive Whether the base time is inclusive or not.
     * @param result    Receives the most recent transition before the base time.
     * @return  true if the transition is found.
     * @stable ICU 3.8
     */
    virtual UBool getPreviousTransition(UDate base, UBool inclusive, TimeZoneTransition& result) const override;

    /**
     * Returns the number of <code>TimeZoneRule</code>s which represents time transitions,
     * for this time zone, that is, all <code>TimeZoneRule</code>s for this time zone except
     * <code>InitialTimeZoneRule</code>.  The return value range is 0 or any positive value.
     * @param status    Receives error status code.
     * @return The number of <code>TimeZoneRule</code>s representing time transitions.
     * @stable ICU 3.8
     */
    virtual int32_t countTransitionRules(UErrorCode& status) const override;

    /**
     * Gets the <code>InitialTimeZoneRule</code> and the set of <code>TimeZoneRule</code>
     * which represent time transitions for this time zone.  On successful return,
     * the argument initial points to non-nullptr <code>InitialTimeZoneRule</code> and
     * the array trsrules is filled with 0 or multiple <code>TimeZoneRule</code>
     * instances up to the size specified by trscount.  The results are referencing the
     * rule instance held by this time zone instance.  Therefore, after this time zone
     * is destructed, they are no longer available.
     * @param initial       Receives the initial timezone rule
     * @param trsrules      Receives the timezone transition rules
     * @param trscount      On input, specify the size of the array 'transitions' receiving
     *                      the timezone transition rules.  On output, actual number of
     *                      rules filled in the array will be set.
     * @param status        Receives error status code.
     * @stable ICU 3.8
     */
    virtual void getTimeZoneRules(const InitialTimeZoneRule*& initial,
        const TimeZoneRule* trsrules[], int32_t& trscount, UErrorCode& status) const override;


public:

    /**
     * Override TimeZone Returns a unique class ID POLYMORPHICALLY. Pure virtual
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
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       Derived::getStaticClassID()) ...
     * </pre>
     * @return   The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

private:
    /**
     * Constants specifying values of startMode and endMode.
     */
    enum EMode
    {
        DOM_MODE = 1,
        DOW_IN_MONTH_MODE,
        DOW_GE_DOM_MODE,
        DOW_LE_DOM_MODE
    };

    SimpleTimeZone() = delete; // default constructor not implemented

    /**
     * Internal construction method.
     * @param rawOffsetGMT    The new SimpleTimeZone's raw GMT offset
     * @param startMonth      the month DST starts
     * @param startDay        the day DST starts
     * @param startDayOfWeek  the DOW DST starts
     * @param startTime       the time DST starts
     * @param startTimeMode   Whether the start time is local wall time, local
     *                        standard time, or UTC time. Default is local wall time.
     * @param endMonth        the month DST ends
     * @param endDay          the day DST ends
     * @param endDayOfWeek    the DOW DST ends
     * @param endTime         the time DST ends
     * @param endTimeMode     Whether the end time is local wall time, local
     *                        standard time, or UTC time. Default is local wall time.
     * @param dstSavings      The number of milliseconds added to standard time
     *                        to get DST time. Default is one hour.
     * @param status          An UErrorCode to receive the status.
     */
    void construct(int32_t rawOffsetGMT,
                   int8_t startMonth, int8_t startDay, int8_t startDayOfWeek,
                   int32_t startTime, TimeMode startTimeMode,
                   int8_t endMonth, int8_t endDay, int8_t endDayOfWeek,
                   int32_t endTime, TimeMode endTimeMode,
                   int32_t dstSavings, UErrorCode& status);

    /**
     * Compare a given date in the year to a rule. Return 1, 0, or -1, depending
     * on whether the date is after, equal to, or before the rule date. The
     * millis are compared directly against the ruleMillis, so any
     * standard-daylight adjustments must be handled by the caller.
     *
     * @return  1 if the date is after the rule date, -1 if the date is before
     *          the rule date, or 0 if the date is equal to the rule date.
     */
    static int32_t compareToRule(int8_t month, int8_t monthLen, int8_t prevMonthLen,
                                 int8_t dayOfMonth,
                                 int8_t dayOfWeek, int32_t millis, int32_t millisDelta,
                                 EMode ruleMode, int8_t ruleMonth, int8_t ruleDayOfWeek,
                                 int8_t ruleDay, int32_t ruleMillis);

    /**
     * Given a set of encoded rules in startDay and startDayOfMonth, decode
     * them and set the startMode appropriately.  Do the same for endDay and
     * endDayOfMonth.
     * <P>
     * Upon entry, the day of week variables may be zero or
     * negative, in order to indicate special modes.  The day of month
     * variables may also be negative.
     * <P>
     * Upon exit, the mode variables will be
     * set, and the day of week and day of month variables will be positive.
     * <P>
     * This method also recognizes a startDay or endDay of zero as indicating
     * no DST.
     */
    void decodeRules(UErrorCode& status);
    void decodeStartRule(UErrorCode& status);
    void decodeEndRule(UErrorCode& status);

    int8_t startMonth, startDay, startDayOfWeek;   // the month, day, DOW, and time DST starts
    int32_t startTime;
    TimeMode startTimeMode, endTimeMode; // Mode for startTime, endTime; see TimeMode
    int8_t endMonth, endDay, endDayOfWeek; // the month, day, DOW, and time DST ends
    int32_t endTime;
    int32_t startYear;  // the year these DST rules took effect
    int32_t rawOffset;  // the TimeZone's raw GMT offset
    UBool useDaylight; // flag indicating whether this TimeZone uses DST
    static const int8_t STATICMONTHLENGTH[12]; // lengths of the months
    EMode startMode, endMode;   // flags indicating what kind of rules the DST rules are

    /**
     * A positive value indicating the amount of time saved during DST in ms.
     * Typically one hour; sometimes 30 minutes.
     */
    int32_t dstSavings;

    /* Private for BasicTimeZone implementation */
    void checkTransitionRules(UErrorCode& status) const;
    void initTransitionRules(UErrorCode& status);
    void clearTransitionRules();
    void deleteTransitionRules();
    UBool   transitionRulesInitialized;
    InitialTimeZoneRule*    initialRule;
    TimeZoneTransition*     firstTransition;
    AnnualTimeZoneRule*     stdRule;
    AnnualTimeZoneRule*     dstRule;
};

inline void SimpleTimeZone::setStartRule(int32_t month, int32_t dayOfWeekInMonth,
                                         int32_t dayOfWeek,
                                         int32_t time, UErrorCode& status) {
    setStartRule(month, dayOfWeekInMonth, dayOfWeek, time, WALL_TIME, status);
}

inline void SimpleTimeZone::setStartRule(int32_t month, int32_t dayOfMonth,
                                         int32_t time,
                                         UErrorCode& status) {
    setStartRule(month, dayOfMonth, time, WALL_TIME, status);
}

inline void SimpleTimeZone::setStartRule(int32_t month, int32_t dayOfMonth,
                                         int32_t dayOfWeek,
                                         int32_t time, UBool after, UErrorCode& status) {
    setStartRule(month, dayOfMonth, dayOfWeek, time, WALL_TIME, after, status);
}

inline void SimpleTimeZone::setEndRule(int32_t month, int32_t dayOfWeekInMonth,
                                       int32_t dayOfWeek,
                                       int32_t time, UErrorCode& status) {
    setEndRule(month, dayOfWeekInMonth, dayOfWeek, time, WALL_TIME, status);
}

inline void SimpleTimeZone::setEndRule(int32_t month, int32_t dayOfMonth,
                                       int32_t time, UErrorCode& status) {
    setEndRule(month, dayOfMonth, time, WALL_TIME, status);
}

inline void SimpleTimeZone::setEndRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek,
                                       int32_t time, UBool after, UErrorCode& status) {
    setEndRule(month, dayOfMonth, dayOfWeek, time, WALL_TIME, after, status);
}

inline void
SimpleTimeZone::getOffset(UDate date, UBool local, int32_t& rawOffsetRef,
                          int32_t& dstOffsetRef, UErrorCode& ec) const {
    TimeZone::getOffset(date, local, rawOffsetRef, dstOffsetRef, ec);
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _SIMPLETZ
