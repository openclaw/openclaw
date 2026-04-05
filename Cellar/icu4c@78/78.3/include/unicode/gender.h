// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2008-2013, International Business Machines Corporation and
* others. All Rights Reserved.
*******************************************************************************
*
*
* File GENDER.H
*
* Modification History:*
*   Date        Name        Description
*
********************************************************************************
*/

#ifndef _GENDER
#define _GENDER

/**
 * \file
 * \brief C++ API: GenderInfo computes the gender of a list.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/locid.h"
#include "unicode/ugender.h"
#include "unicode/uobject.h"

class GenderInfoTest;

U_NAMESPACE_BEGIN

/** \internal Forward Declaration  */
void U_CALLCONV GenderInfo_initCache(UErrorCode &status);

/**
 * GenderInfo computes the gender of a list as a whole given the gender of
 * each element.
 * @stable ICU 50
 */
class U_I18N_API GenderInfo : public UObject {
public:

    /**
     * Provides access to the predefined GenderInfo object for a given
     * locale.
     *
     * @param locale  The locale for which a <code>GenderInfo</code> object is
     *                returned.
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        The predefined <code>GenderInfo</code> object pointer for
     *                this locale. The returned object is immutable, so it is
     *                declared as const. Caller does not own the returned
     *                pointer, so it must not attempt to free it.
     * @stable ICU 50
     */
    static const GenderInfo* U_EXPORT2 getInstance(const Locale& locale, UErrorCode& status);

    /**
     * Determines the gender of a list as a whole given the gender of each
     * of the elements.
     * 
     * @param genders the gender of each element in the list.
     * @param length the length of gender array.
     * @param status  Output param set to success/failure code on exit, which
     *                must not indicate a failure before the function call.
     * @return        the gender of the whole list.
     * @stable ICU 50
     */
    UGender getListGender(const UGender* genders, int32_t length, UErrorCode& status) const;

    /**
     * Destructor.
     *
     * @stable ICU 50
     */
    virtual ~GenderInfo();

private:
    int32_t _style;

    /**
     * Copy constructor. One object per locale invariant. Clients
     * must never copy GenderInfo objects.
     */
    GenderInfo(const GenderInfo& other) = delete;

    /**
      * Assignment operator. Not applicable to immutable objects.
      */
    GenderInfo& operator=(const GenderInfo&) = delete;

    GenderInfo();

    static const GenderInfo* getNeutralInstance();

    static const GenderInfo* getMixedNeutralInstance();

    static const GenderInfo* getMaleTaintsInstance();

    static const GenderInfo* loadInstance(const Locale& locale, UErrorCode& status);

    friend class ::GenderInfoTest;
    friend void U_CALLCONV GenderInfo_initCache(UErrorCode &status);
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _GENDER
//eof
