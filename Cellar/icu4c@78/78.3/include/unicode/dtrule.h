// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2008, International Business Machines Corporation and         *
* others. All Rights Reserved.                                                *
*******************************************************************************
*/
#ifndef DTRULE_H
#define DTRULE_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: Rule for specifying date and time in an year
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"

U_NAMESPACE_BEGIN
/**
 * <code>DateTimeRule</code> is a class representing a time in a year by
 * a rule specified by month, day of month, day of week and
 * time in the day.
 * 
 * @stable ICU 3.8
 */
class U_I18N_API DateTimeRule : public UObject {
public:

    /**
     * Date rule type constants.
     * @stable ICU 3.8
     */
    enum DateRuleType {
        DOM = 0,        /**< The exact day of month,
                             for example, March 11. */
        DOW,            /**< The Nth occurrence of the day of week,
                             for example, 2nd Sunday in March. */
        DOW_GEQ_DOM,    /**< The first occurrence of the day of week on or after the day of monnth,
                             for example, first Sunday on or after March 8. */
        DOW_LEQ_DOM     /**< The last occurrence of the day of week on or before the day of month,
                             for example, first Sunday on or before March 14. */
    };

    /**
     * Time rule type constants.
     * @stable ICU 3.8
     */
    enum TimeRuleType {
        WALL_TIME = 0,  /**< The local wall clock time */
        STANDARD_TIME,  /**< The local standard time */
        UTC_TIME        /**< The UTC time */
    };

    /**
     * Constructs a <code>DateTimeRule</code> by the day of month and
     * the time rule.  The date rule type for an instance created by
     * this constructor is <code>DOM</code>.
     * 
     * @param month         The rule month, for example, <code>Calendar::JANUARY</code>
     * @param dayOfMonth    The day of month, 1-based.
     * @param millisInDay   The milliseconds in the rule date.
     * @param timeType      The time type, <code>WALL_TIME</code> or <code>STANDARD_TIME</code>
     *                      or <code>UTC_TIME</code>.
     * @stable ICU 3.8
     */
    DateTimeRule(int32_t month, int32_t dayOfMonth,
        int32_t millisInDay, TimeRuleType timeType);

    /**
     * Constructs a <code>DateTimeRule</code> by the day of week and its ordinal
     * number and the time rule.  The date rule type for an instance created
     * by this constructor is <code>DOW</code>.
     * 
     * @param month         The rule month, for example, <code>Calendar::JANUARY</code>.
     * @param weekInMonth   The ordinal number of the day of week.  Negative number
     *                      may be used for specifying a rule date counted from the
     *                      end of the rule month.
     * @param dayOfWeek     The day of week, for example, <code>Calendar::SUNDAY</code>.
     * @param millisInDay   The milliseconds in the rule date.
     * @param timeType      The time type, <code>WALL_TIME</code> or <code>STANDARD_TIME</code>
     *                      or <code>UTC_TIME</code>.
     * @stable ICU 3.8
     */
    DateTimeRule(int32_t month, int32_t weekInMonth, int32_t dayOfWeek,
        int32_t millisInDay, TimeRuleType timeType);

    /**
     * Constructs a <code>DateTimeRule</code> by the first/last day of week
     * on or after/before the day of month and the time rule.  The date rule
     * type for an instance created by this constructor is either
     * <code>DOM_GEQ_DOM</code> or <code>DOM_LEQ_DOM</code>.
     * 
     * @param month         The rule month, for example, <code>Calendar::JANUARY</code>
     * @param dayOfMonth    The day of month, 1-based.
     * @param dayOfWeek     The day of week, for example, <code>Calendar::SUNDAY</code>.
     * @param after         true if the rule date is on or after the day of month.
     * @param millisInDay   The milliseconds in the rule date.
     * @param timeType      The time type, <code>WALL_TIME</code> or <code>STANDARD_TIME</code>
     *                      or <code>UTC_TIME</code>.
     * @stable ICU 3.8
     */
    DateTimeRule(int32_t month, int32_t dayOfMonth, int32_t dayOfWeek, UBool after,
        int32_t millisInDay, TimeRuleType timeType);

    /**
     * Copy constructor.
     * @param source    The DateTimeRule object to be copied.
     * @stable ICU 3.8
     */
    DateTimeRule(const DateTimeRule& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    ~DateTimeRule();

    /**
     * Clone this DateTimeRule object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return    A copy of the object.
     * @stable ICU 3.8
     */
    DateTimeRule* clone() const;

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    DateTimeRule& operator=(const DateTimeRule& right);

    /**
     * Return true if the given DateTimeRule objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given DateTimeRule objects are semantically equal.
     * @stable ICU 3.8
     */
    bool operator==(const DateTimeRule& that) const;

    /**
     * Return true if the given DateTimeRule objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given DateTimeRule objects are semantically unequal.
     * @stable ICU 3.8
     */
    bool operator!=(const DateTimeRule& that) const;

    /**
     * Gets the date rule type, such as <code>DOM</code>
     * @return The date rule type.
     * @stable ICU 3.8
     */
    DateRuleType getDateRuleType() const;

    /**
     * Gets the time rule type
     * @return The time rule type, either <code>WALL_TIME</code> or <code>STANDARD_TIME</code>
     *         or <code>UTC_TIME</code>.
     * @stable ICU 3.8
     */
    TimeRuleType getTimeRuleType() const;

    /**
     * Gets the rule month.
     * @return The rule month.
     * @stable ICU 3.8
     */
    int32_t getRuleMonth() const;

    /**
     * Gets the rule day of month.  When the date rule type
     * is <code>DOW</code>, the value is always 0.
     * @return The rule day of month
     * @stable ICU 3.8
     */
    int32_t getRuleDayOfMonth() const;

    /**
     * Gets the rule day of week.  When the date rule type
     * is <code>DOM</code>, the value is always 0.
     * @return The rule day of week.
     * @stable ICU 3.8
     */
    int32_t getRuleDayOfWeek() const;

    /**
     * Gets the ordinal number of the occurrence of the day of week
     * in the month.  When the date rule type is not <code>DOW</code>,
     * the value is always 0.
     * @return The rule day of week ordinal number in the month.
     * @stable ICU 3.8
     */
    int32_t getRuleWeekInMonth() const;

    /**
     * Gets the rule time in the rule day.
     * @return The time in the rule day in milliseconds.
     * @stable ICU 3.8
     */
    int32_t getRuleMillisInDay() const;

  private:
    int32_t fMonth;
    int32_t fDayOfMonth;
    int32_t fDayOfWeek;
    int32_t fWeekInMonth;
    int32_t fMillisInDay;
    DateRuleType fDateRuleType;
    TimeRuleType fTimeRuleType;

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

#endif // DTRULE_H
//eof
