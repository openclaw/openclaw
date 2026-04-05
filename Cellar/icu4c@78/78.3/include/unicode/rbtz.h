// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2013, International Business Machines Corporation and    *
* others. All Rights Reserved.                                                *
*******************************************************************************
*/
#ifndef RBTZ_H
#define RBTZ_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: Rule based customizable time zone
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/basictz.h"
#include "unicode/unistr.h"

U_NAMESPACE_BEGIN

// forward declaration
class UVector;
struct Transition;

/**
 * a BasicTimeZone subclass implemented in terms of InitialTimeZoneRule and TimeZoneRule instances
 * @see BasicTimeZone
 * @see InitialTimeZoneRule
 * @see TimeZoneRule
 */
class U_I18N_API RuleBasedTimeZone : public BasicTimeZone {
public:
    /**
     * Constructs a <code>RuleBasedTimeZone</code> object with the ID and the
     * <code>InitialTimeZoneRule</code>.  The input <code>InitialTimeZoneRule</code>
     * is adopted by this <code>RuleBasedTimeZone</code>, thus the caller must not
     * delete it.
     * @param id                The time zone ID.
     * @param initialRule       The initial time zone rule.
     * @stable ICU 3.8
     */
    RuleBasedTimeZone(const UnicodeString& id, InitialTimeZoneRule* initialRule);

    /**
     * Copy constructor.
     * @param source    The RuleBasedTimeZone object to be copied.
     * @stable ICU 3.8
     */
    RuleBasedTimeZone(const RuleBasedTimeZone& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    virtual ~RuleBasedTimeZone();

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    RuleBasedTimeZone& operator=(const RuleBasedTimeZone& right);

    /**
     * Return true if the given <code>TimeZone</code> objects are
     * semantically equal. Objects of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZone</code> objects are
      *semantically equal.
     * @stable ICU 3.8
     */
    virtual bool operator==(const TimeZone& that) const override;

    /**
     * Return true if the given <code>TimeZone</code> objects are
     * semantically unequal. Objects of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given <code>TimeZone</code> objects are
     * semantically unequal.
     * @stable ICU 3.8
     */
    virtual bool operator!=(const TimeZone& that) const;

    /**
     * Adds the `TimeZoneRule` which represents time transitions.
     * The `TimeZoneRule` must have start times, that is, the result
     * of `isTransitionRule()` must be true. Otherwise, U_ILLEGAL_ARGUMENT_ERROR
     * is set to the error code.
     * The input `TimeZoneRule` is adopted by this `RuleBasedTimeZone`;
     * the caller must not delete it. Should an error condition prevent
     * the successful adoption of the rule, this function will delete it.
     *
     * After all rules are added, the caller must call `complete()` method to
     * make this `RuleBasedTimeZone` ready to handle common time
     * zone functions.
     * @param rule The `TimeZoneRule`.
     * @param status Output param to filled in with a success or an error.
     * @stable ICU 3.8
     */
    void addTransitionRule(TimeZoneRule* rule, UErrorCode& status);

    /**
     * Makes the <code>TimeZoneRule</code> ready to handle actual timezone
     * calculation APIs.  This method collects time zone rules specified
     * by the caller via the constructor and addTransitionRule() and
     * builds internal structure for making the object ready to support
     * time zone APIs such as getOffset(), getNextTransition() and others.
     * @param status Output param to filled in with a success or an error.
     * @stable ICU 3.8
     */
    void complete(UErrorCode& status);

    /**
     * Clones TimeZone objects polymorphically. Clients are responsible for deleting
     * the TimeZone object cloned.
     *
     * @return   A new copy of this TimeZone object.
     * @stable ICU 3.8
     */
    virtual RuleBasedTimeZone* clone() const override;

    /**
     * Returns the TimeZone's adjusted GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time in this time zone, taking daylight savings time into
     * account) as of a particular reference date.  The reference date is used to determine
     * whether daylight savings time is in effect and needs to be figured into the offset
     * that is returned (in other words, what is the adjusted GMT offset in this time zone
     * at this particular date and time?).  For the time zones produced by createTimeZone(),
     * the reference data is specified according to the Gregorian calendar, and the date
     * and time fields are local standard time.
     *
     * <p>Note: Don't call this method. Instead, call the getOffset(UDate...) overload,
     * which returns both the raw and the DST offset for a given time. This method
     * is retained only for backward compatibility.
     *
     * @param era        The reference date's era
     * @param year       The reference date's year
     * @param month      The reference date's month (0-based; 0 is January)
     * @param day        The reference date's day-in-month (1-based)
     * @param dayOfWeek  The reference date's day-of-week (1-based; 1 is Sunday)
     * @param millis     The reference date's milliseconds in day, local standard time
     * @param status     Output param to filled in with a success or an error.
     * @return           The offset in milliseconds to add to GMT to get local time.
     * @stable ICU 3.8
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                              uint8_t dayOfWeek, int32_t millis, UErrorCode& status) const override;

    /**
     * Gets the time zone offset, for current date, modified in case of
     * daylight savings. This is the offset to add *to* UTC to get local time.
     *
     * <p>Note: Don't call this method. Instead, call the getOffset(UDate...) overload,
     * which returns both the raw and the DST offset for a given time. This method
     * is retained only for backward compatibility.
     *
     * @param era        The reference date's era
     * @param year       The reference date's year
     * @param month      The reference date's month (0-based; 0 is January)
     * @param day        The reference date's day-in-month (1-based)
     * @param dayOfWeek  The reference date's day-of-week (1-based; 1 is Sunday)
     * @param millis     The reference date's milliseconds in day, local standard time
     * @param monthLength The length of the given month in days.
     * @param status     Output param to filled in with a success or an error.
     * @return           The offset in milliseconds to add to GMT to get local time.
     * @stable ICU 3.8
     */
    virtual int32_t getOffset(uint8_t era, int32_t year, int32_t month, int32_t day,
                           uint8_t dayOfWeek, int32_t millis,
                           int32_t monthLength, UErrorCode& status) const override;

    /**
     * Returns the time zone raw and GMT offset for the given moment
     * in time.  Upon return, local-millis = GMT-millis + rawOffset +
     * dstOffset.  All computations are performed in the proleptic
     * Gregorian calendar.  The default implementation in the TimeZone
     * class delegates to the 8-argument getOffset().
     *
     * @param date moment in time for which to return offsets, in
     * units of milliseconds from January 1, 1970 0:00 GMT, either GMT
     * time or local wall time, depending on `local'.
     * @param local if true, `date' is local wall time; otherwise it
     * is in GMT time.
     * @param rawOffset output parameter to receive the raw offset, that
     * is, the offset not including DST adjustments
     * @param dstOffset output parameter to receive the DST offset,
     * that is, the offset to be added to `rawOffset' to obtain the
     * total offset between local and GMT time. If DST is not in
     * effect, this value is zero; otherwise it is a positive value,
     * typically one hour.
     * @param ec input-output error code
     * @stable ICU 3.8
     */
    virtual void getOffset(UDate date, UBool local, int32_t& rawOffset,
                           int32_t& dstOffset, UErrorCode& ec) const override;

    /**
     * Sets the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @param offsetMillis  The new raw GMT offset for this time zone.
     * @stable ICU 3.8
     */
    virtual void setRawOffset(int32_t offsetMillis) override;

    /**
     * Returns the TimeZone's raw GMT offset (i.e., the number of milliseconds to add
     * to GMT to get local time, before taking daylight savings time into account).
     *
     * @return   The TimeZone's raw GMT offset.
     * @stable ICU 3.8
     */
    virtual int32_t getRawOffset() const override;

    /**
     * Queries if this time zone uses daylight savings time.
     * @return true if this time zone uses daylight savings time,
     * false, otherwise.
     * @stable ICU 3.8
     */
    virtual UBool useDaylightTime() const override;

#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * Queries if the given date is in daylight savings time in
     * this time zone.
     * This method is wasteful since it creates a new GregorianCalendar and
     * deletes it each time it is called. This is a deprecated method
     * and provided only for Java compatibility.
     *
     * @param date the given UDate.
     * @param status Output param filled in with success/error code.
     * @return true if the given date is in daylight savings time,
     * false, otherwise.
     * @deprecated ICU 2.4. Use Calendar::inDaylightTime() instead.
     */
    virtual UBool inDaylightTime(UDate date, UErrorCode& status) const override;
#endif  // U_FORCE_HIDE_DEPRECATED_API

    /**
     * Returns true if this zone has the same rule and offset as another zone.
     * That is, if this zone differs only in ID, if at all.
     * @param other the <code>TimeZone</code> object to be compared with
     * @return true if the given zone is the same as this one,
     * with the possible exception of the ID
     * @stable ICU 3.8
     */
    virtual UBool hasSameRules(const TimeZone& other) const override;

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

    /**
     * Get time zone offsets from local wall time.
     * @stable ICU 69
     */
    virtual void getOffsetFromLocal(
        UDate date, UTimeZoneLocalOption nonExistingTimeOpt,
        UTimeZoneLocalOption duplicatedTimeOpt,
        int32_t& rawOffset, int32_t& dstOffset, UErrorCode& status) const override;

private:
    void deleteRules();
    void deleteTransitions();
    UVector* copyRules(UVector* source);
    TimeZoneRule* findRuleInFinal(UDate date, UBool local,
        int32_t NonExistingTimeOpt, int32_t DuplicatedTimeOpt) const;
    UBool findNext(UDate base, UBool inclusive, UDate& time, TimeZoneRule*& from, TimeZoneRule*& to) const;
    UBool findPrev(UDate base, UBool inclusive, UDate& time, TimeZoneRule*& from, TimeZoneRule*& to) const;
    int32_t getLocalDelta(int32_t rawBefore, int32_t dstBefore, int32_t rawAfter, int32_t dstAfter,
        int32_t NonExistingTimeOpt, int32_t DuplicatedTimeOpt) const;
    UDate getTransitionTime(Transition* transition, UBool local,
        int32_t NonExistingTimeOpt, int32_t DuplicatedTimeOpt) const;
    void getOffsetInternal(UDate date, UBool local, int32_t NonExistingTimeOpt, int32_t DuplicatedTimeOpt,
        int32_t& rawOffset, int32_t& dstOffset, UErrorCode& ec) const;
    void completeConst(UErrorCode &status) const;

    InitialTimeZoneRule *fInitialRule;
    UVector             *fHistoricRules;
    UVector             *fFinalRules;
    UVector             *fHistoricTransitions;
    UBool               fUpToDate;

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

#endif // RBTZ_H

//eof
