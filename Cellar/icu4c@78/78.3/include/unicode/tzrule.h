// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2008, International Business Machines Corporation and    *
* others. All Rights Reserved.                                                *
*******************************************************************************
*/
#ifndef TZRULE_H
#define TZRULE_H

/**
 * \file 
 * \brief C++ API: Time zone rule classes
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"
#include "unicode/unistr.h"
#include "unicode/dtrule.h"

U_NAMESPACE_BEGIN

/**
 * <code>TimeZoneRule</code> is a class representing a rule for time zone.
 * <code>TimeZoneRule</code> has a set of time zone attributes, such as zone name,
 * raw offset (UTC offset for standard time) and daylight saving time offset.
 * 
 * @stable ICU 3.8
 */
class U_I18N_API TimeZoneRule : public UObject {
public:
    /**
     * Destructor.
     * @stable ICU 3.8
     */
    virtual ~TimeZoneRule();

    /**
     * Clone this TimeZoneRule object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return  A copy of the object.
     * @stable ICU 3.8
     */
    virtual TimeZoneRule* clone() const = 0;

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically equal.
     * @stable ICU 3.8
     */
    virtual bool operator==(const TimeZoneRule& that) const;

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically unequal.
     * @stable ICU 3.8
     */
    virtual bool operator!=(const TimeZoneRule& that) const;

    /**
     * Fills in "name" with the name of this time zone.
     * @param name  Receives the name of this time zone.
     * @return  A reference to "name"
     * @stable ICU 3.8
     */
    UnicodeString& getName(UnicodeString& name) const;

    /**
     * Gets the standard time offset.
     * @return  The standard time offset from UTC in milliseconds.
     * @stable ICU 3.8
     */
    int32_t getRawOffset() const;

    /**
     * Gets the amount of daylight saving delta time from the standard time.
     * @return  The amount of daylight saving offset used by this rule
     *          in milliseconds.
     * @stable ICU 3.8
     */
    int32_t getDSTSavings() const;

    /**
     * Returns if this rule represents the same rule and offsets as another.
     * When two <code>TimeZoneRule</code> objects differ only its names, this method
     * returns true.
     * @param other The <code>TimeZoneRule</code> object to be compared with.
     * @return  true if the other <code>TimeZoneRule</code> is the same as this one.
     * @stable ICU 3.8
     */
    virtual UBool isEquivalentTo(const TimeZoneRule& other) const;

    /**
     * Gets the very first time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the very first time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFirstStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const = 0;

    /**
     * Gets the final time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the final time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFinalStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const = 0;

    /**
     * Gets the first time when this rule takes effect after the specified time.
     * @param base              The first start time after this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The first time when this rule takes effect after
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getNextStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const = 0;

    /**
     * Gets the most recent time when this rule takes effect before the specified time.
     * @param base              The most recent time before this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The most recent time when this rule takes effect before
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getPreviousStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const = 0;

protected:

    /**
     * Constructs a <code>TimeZoneRule</code> with the name, the GMT offset of its
     * standard time and the amount of daylight saving offset adjustment.
     * @param name          The time zone name.
     * @param rawOffset     The UTC offset of its standard time in milliseconds.
     * @param dstSavings    The amount of daylight saving offset adjustment in milliseconds.
     *                      If this ia a rule for standard time, the value of this argument is 0.
     * @stable ICU 3.8
     */
    TimeZoneRule(const UnicodeString& name, int32_t rawOffset, int32_t dstSavings);

    /**
     * Copy constructor.
     * @param source    The TimeZoneRule object to be copied.
     * @stable ICU 3.8
     */
    TimeZoneRule(const TimeZoneRule& source);

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    TimeZoneRule& operator=(const TimeZoneRule& right);

private:
    UnicodeString fName; // time name
    int32_t fRawOffset;  // UTC offset of the standard time in milliseconds
    int32_t fDSTSavings; // DST saving amount in milliseconds
};

/**
 * <code>InitialTimeZoneRule</code> represents a time zone rule
 * representing a time zone effective from the beginning and
 * has no actual start times.
 * @stable ICU 3.8
 */
class U_I18N_API InitialTimeZoneRule : public TimeZoneRule {
public:
    /**
     * Constructs an <code>InitialTimeZoneRule</code> with the name, the GMT offset of its
     * standard time and the amount of daylight saving offset adjustment.
     * @param name          The time zone name.
     * @param rawOffset     The UTC offset of its standard time in milliseconds.
     * @param dstSavings    The amount of daylight saving offset adjustment in milliseconds.
     *                      If this ia a rule for standard time, the value of this argument is 0.
     * @stable ICU 3.8
     */
    InitialTimeZoneRule(const UnicodeString& name, int32_t rawOffset, int32_t dstSavings);

    /**
     * Copy constructor.
     * @param source    The InitialTimeZoneRule object to be copied.
     * @stable ICU 3.8
     */
    InitialTimeZoneRule(const InitialTimeZoneRule& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    virtual ~InitialTimeZoneRule();

    /**
     * Clone this InitialTimeZoneRule object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return    A copy of the object.
     * @stable ICU 3.8
     */
    virtual InitialTimeZoneRule* clone() const override;

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    InitialTimeZoneRule& operator=(const InitialTimeZoneRule& right);

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically equal.
     * @stable ICU 3.8
     */
    virtual bool operator==(const TimeZoneRule& that) const override;

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically unequal.
     * @stable ICU 3.8
     */
    virtual bool operator!=(const TimeZoneRule& that) const override;

    /**
     * Returns if this rule represents the same rule and offsets as another.
     * When two <code>TimeZoneRule</code> objects differ only its names, this method
     * returns true.
     * @param that  The <code>TimeZoneRule</code> object to be compared with.
     * @return  true if the other <code>TimeZoneRule</code> is equivalent to this one.
     * @stable ICU 3.8
     */
    virtual UBool isEquivalentTo(const TimeZoneRule& that) const override;

    /**
     * Gets the very first time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the very first time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFirstStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the final time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the final time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFinalStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the first time when this rule takes effect after the specified time.
     * @param base              The first start time after this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The first time when this rule takes effect after
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getNextStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;

    /**
     * Gets the most recent time when this rule takes effect before the specified time.
     * @param base              The most recent time before this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The most recent time when this rule takes effect before
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getPreviousStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;

public:
    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 3.8
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 3.8
     */
    virtual UClassID getDynamicClassID() const override;
};

/**
 * <code>AnnualTimeZoneRule</code> is a class used for representing a time zone
 * rule which takes effect annually.  The calendar system used for the rule is
 * is based on Gregorian calendar
 * 
 * @stable ICU 3.8
 */
class U_I18N_API AnnualTimeZoneRule : public TimeZoneRule {
public:
    /**
     * The constant representing the maximum year used for designating
     * a rule is permanent.
     */
    static const int32_t MAX_YEAR;

    /**
     * Constructs a <code>AnnualTimeZoneRule</code> with the name, the GMT offset of its
     * standard time, the amount of daylight saving offset adjustment, the annual start
     * time rule and the start/until years.  The input DateTimeRule is copied by this
     * constructor, so the caller remains responsible for deleting the object.
     * @param name          The time zone name.
     * @param rawOffset     The GMT offset of its standard time in milliseconds.
     * @param dstSavings    The amount of daylight saving offset adjustment in
     *                      milliseconds.  If this ia a rule for standard time,
     *                      the value of this argument is 0.
     * @param dateTimeRule  The start date/time rule repeated annually.
     * @param startYear     The first year when this rule takes effect.
     * @param endYear       The last year when this rule takes effect.  If this
     *                      rule is effective forever in future, specify MAX_YEAR.
     * @stable ICU 3.8
     */
    AnnualTimeZoneRule(const UnicodeString& name, int32_t rawOffset, int32_t dstSavings,
            const DateTimeRule& dateTimeRule, int32_t startYear, int32_t endYear);

    /**
     * Constructs a <code>AnnualTimeZoneRule</code> with the name, the GMT offset of its
     * standard time, the amount of daylight saving offset adjustment, the annual start
     * time rule and the start/until years.  The input DateTimeRule object is adopted
     * by this object, therefore, the caller must not delete the object.
     * @param name          The time zone name.
     * @param rawOffset     The GMT offset of its standard time in milliseconds.
     * @param dstSavings    The amount of daylight saving offset adjustment in
     *                      milliseconds.  If this ia a rule for standard time,
     *                      the value of this argument is 0.
     * @param dateTimeRule  The start date/time rule repeated annually.
     * @param startYear     The first year when this rule takes effect.
     * @param endYear       The last year when this rule takes effect.  If this
     *                      rule is effective forever in future, specify MAX_YEAR.
     * @stable ICU 3.8
     */
    AnnualTimeZoneRule(const UnicodeString& name, int32_t rawOffset, int32_t dstSavings,
            DateTimeRule* dateTimeRule, int32_t startYear, int32_t endYear);

    /**
     * Copy constructor.
     * @param source    The AnnualTimeZoneRule object to be copied.
     * @stable ICU 3.8
     */
    AnnualTimeZoneRule(const AnnualTimeZoneRule& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    virtual ~AnnualTimeZoneRule();

    /**
     * Clone this AnnualTimeZoneRule object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return    A copy of the object.
     * @stable ICU 3.8
     */
    virtual AnnualTimeZoneRule* clone() const override;

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    AnnualTimeZoneRule& operator=(const AnnualTimeZoneRule& right);

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically equal.
     * @stable ICU 3.8
     */
    virtual bool operator==(const TimeZoneRule& that) const override;

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically unequal.
     * @stable ICU 3.8
     */
    virtual bool operator!=(const TimeZoneRule& that) const override;

    /**
     * Gets the start date/time rule used by this rule.
     * @return  The <code>AnnualDateTimeRule</code> which represents the start date/time
     *          rule used by this time zone rule.
     * @stable ICU 3.8
     */
    const DateTimeRule* getRule() const;

    /**
     * Gets the first year when this rule takes effect.
     * @return  The start year of this rule.  The year is in Gregorian calendar
     *          with 0 == 1 BCE, -1 == 2 BCE, etc.
     * @stable ICU 3.8
     */
    int32_t getStartYear() const;

    /**
     * Gets the end year when this rule takes effect.
     * @return  The end year of this rule (inclusive). The year is in Gregorian calendar
     *          with 0 == 1 BCE, -1 == 2 BCE, etc.
     * @stable ICU 3.8
     */
    int32_t getEndYear() const;

    /**
     * Gets the time when this rule takes effect in the given year.
     * @param year              The Gregorian year, with 0 == 1 BCE, -1 == 2 BCE, etc.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the start time in the year.
     * @return  true if this rule takes effect in the year and the result is set to
     *          "result".
     * @stable ICU 3.8
     */
    UBool getStartInYear(int32_t year, int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const;

    /**
     * Returns if this rule represents the same rule and offsets as another.
     * When two <code>TimeZoneRule</code> objects differ only its names, this method
     * returns true.
     * @param that  The <code>TimeZoneRule</code> object to be compared with.
     * @return  true if the other <code>TimeZoneRule</code> is equivalent to this one.
     * @stable ICU 3.8
     */
    virtual UBool isEquivalentTo(const TimeZoneRule& that) const override;

    /**
     * Gets the very first time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the very first time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFirstStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the final time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the final time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFinalStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the first time when this rule takes effect after the specified time.
     * @param base              The first start time after this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The first time when this rule takes effect after
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getNextStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;

    /**
     * Gets the most recent time when this rule takes effect before the specified time.
     * @param base              The most recent time before this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The most recent time when this rule takes effect before
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getPreviousStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;


private:
    DateTimeRule* fDateTimeRule;
    int32_t fStartYear;
    int32_t fEndYear;

public:
    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 3.8
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 3.8
     */
    virtual UClassID getDynamicClassID() const override;
};

/**
 * <code>TimeArrayTimeZoneRule</code> represents a time zone rule whose start times are
 * defined by an array of milliseconds since the standard base time.
 * 
 * @stable ICU 3.8
 */
class U_I18N_API TimeArrayTimeZoneRule : public TimeZoneRule {
public:
    /**
     * Constructs a <code>TimeArrayTimeZoneRule</code> with the name, the GMT offset of its
     * standard time, the amount of daylight saving offset adjustment and
     * the array of times when this rule takes effect.
     * @param name          The time zone name.
     * @param rawOffset     The UTC offset of its standard time in milliseconds.
     * @param dstSavings    The amount of daylight saving offset adjustment in
     *                      milliseconds.  If this ia a rule for standard time,
     *                      the value of this argument is 0.
     * @param startTimes    The array start times in milliseconds since the base time
     *                      (January 1, 1970, 00:00:00).
     * @param numStartTimes The number of elements in the parameter "startTimes"
     * @param timeRuleType  The time type of the start times, which is one of
     *                      <code>DataTimeRule::WALL_TIME</code>, <code>STANDARD_TIME</code>
     *                      and <code>UTC_TIME</code>.
     * @stable ICU 3.8
     */
    TimeArrayTimeZoneRule(const UnicodeString& name, int32_t rawOffset, int32_t dstSavings,
        const UDate* startTimes, int32_t numStartTimes, DateTimeRule::TimeRuleType timeRuleType);

    /**
     * Copy constructor.
     * @param source    The TimeArrayTimeZoneRule object to be copied.
     * @stable ICU 3.8
     */
    TimeArrayTimeZoneRule(const TimeArrayTimeZoneRule& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    virtual ~TimeArrayTimeZoneRule();

    /**
     * Clone this TimeArrayTimeZoneRule object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return    A copy of the object.
     * @stable ICU 3.8
     */
    virtual TimeArrayTimeZoneRule* clone() const override;

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    TimeArrayTimeZoneRule& operator=(const TimeArrayTimeZoneRule& right);

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically equal.
     * @stable ICU 3.8
     */
    virtual bool operator==(const TimeZoneRule& that) const override;

    /**
     * Return true if the given <code>TimeZoneRule</code> objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZoneRule</code> objects are semantically unequal.
     * @stable ICU 3.8
     */
    virtual bool operator!=(const TimeZoneRule& that) const override;

    /**
     * Gets the time type of the start times used by this rule.  The return value
     * is either <code>DateTimeRule::WALL_TIME</code> or <code>STANDARD_TIME</code>
     * or <code>UTC_TIME</code>.
     * 
     * @return The time type used of the start times used by this rule.
     * @stable ICU 3.8
     */
    DateTimeRule::TimeRuleType getTimeType() const;

    /**
     * Gets a start time at the index stored in this rule.
     * @param index     The index of start times
     * @param result    Receives the start time at the index
     * @return  true if the index is within the valid range and
     *          and the result is set.  When false, the output
     *          parameger "result" is unchanged.
     * @stable ICU 3.8
     */
    UBool getStartTimeAt(int32_t index, UDate& result) const;

    /**
     * Returns the number of start times stored in this rule
     * @return The number of start times.
     * @stable ICU 3.8
     */
    int32_t countStartTimes() const;

    /**
     * Returns if this rule represents the same rule and offsets as another.
     * When two <code>TimeZoneRule</code> objects differ only its names, this method
     * returns true.
     * @param that  The <code>TimeZoneRule</code> object to be compared with.
     * @return  true if the other <code>TimeZoneRule</code> is equivalent to this one.
     * @stable ICU 3.8
     */
    virtual UBool isEquivalentTo(const TimeZoneRule& that) const override;

    /**
     * Gets the very first time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the very first time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFirstStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the final time when this rule takes effect.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param result            Receives the final time when this rule takes effect.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getFinalStart(int32_t prevRawOffset, int32_t prevDSTSavings, UDate& result) const override;

    /**
     * Gets the first time when this rule takes effect after the specified time.
     * @param base              The first start time after this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The first time when this rule takes effect after
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getNextStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;

    /**
     * Gets the most recent time when this rule takes effect before the specified time.
     * @param base              The most recent time before this base time will be returned.
     * @param prevRawOffset     The standard time offset from UTC before this rule
     *                          takes effect in milliseconds.
     * @param prevDSTSavings    The amount of daylight saving offset from the
     *                          standard time.
     * @param inclusive         Whether the base time is inclusive or not.
     * @param result            Receives The most recent time when this rule takes effect before
     *                          the specified base time.
     * @return  true if the start time is available.  When false is returned, output parameter
     *          "result" is unchanged.
     * @stable ICU 3.8
     */
    virtual UBool getPreviousStart(UDate base, int32_t prevRawOffset, int32_t prevDSTSavings,
        UBool inclusive, UDate& result) const override;


private:
    enum { TIMEARRAY_STACK_BUFFER_SIZE = 32 };
    UBool initStartTimes(const UDate source[], int32_t size, UErrorCode& ec);
    UDate getUTC(UDate time, int32_t raw, int32_t dst) const;

    DateTimeRule::TimeRuleType  fTimeRuleType;
    int32_t fNumStartTimes;
    UDate*  fStartTimes;
    UDate   fLocalStartTimes[TIMEARRAY_STACK_BUFFER_SIZE];

public:
    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 3.8
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 3.8
     */
    virtual UClassID getDynamicClassID() const override;
};


U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // TZRULE_H

//eof
