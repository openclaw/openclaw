// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2010-2013, International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef UGENDER_H
#define UGENDER_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: The purpose of this API is to compute the gender of a list as a
 * whole given the gender of each element.
 *
 */

/**
 * Genders
 * @stable ICU 50
 */
enum UGender {
    /**
     * Male gender.
     * @stable ICU 50
     */
    UGENDER_MALE,
    /**
     * Female gender.
     * @stable ICU 50
     */
    UGENDER_FEMALE,
    /**
     * Neutral gender.
     * @stable ICU 50
     */
    UGENDER_OTHER
};
/**
 * @stable ICU 50
 */
typedef enum UGender UGender;

struct UGenderInfo;
/**
 * Opaque UGenderInfo object for use in C programs.
 * @stable ICU 50
 */
typedef struct UGenderInfo UGenderInfo;

/**
 * Opens a new UGenderInfo object given locale.
 * @param locale The locale for which the rules are desired.
 * @param status UErrorCode pointer
 * @return A UGenderInfo for the specified locale, or NULL if an error occurred.
 * @stable ICU 50
 */
U_CAPI const UGenderInfo* U_EXPORT2
ugender_getInstance(const char *locale, UErrorCode *status);


/**
 * Given a list, returns the gender of the list as a whole.
 * @param genderInfo pointer that ugender_getInstance returns.
 * @param genders the gender of each element in the list.
 * @param size the size of the list.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The gender of the list.
 * @stable ICU 50
 */
U_CAPI UGender U_EXPORT2
ugender_getListGender(const UGenderInfo* genderInfo, const UGender *genders, int32_t size, UErrorCode *status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
