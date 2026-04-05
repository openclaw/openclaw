// © 2017 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2009-2017, International Business Machines Corporation,       *
 * Google, and others. All Rights Reserved.                                    *
 *******************************************************************************
 */

#ifndef __NOUNIT_H__
#define __NOUNIT_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/measunit.h"

/**
 * \file
 * \brief C++ API: units for percent and permille
 */

U_NAMESPACE_BEGIN

/**
 * Dimensionless unit for percent and permille.
 * Prior to ICU 68, this namespace was a class with the same name.
 * @see NumberFormatter
 * @stable ICU 68
 */
namespace NoUnit {
    /**
     * Returns an instance for the base unit (dimensionless and no scaling).
     *
     * Prior to ICU 68, this function returned a NoUnit by value.
     *
     * Since ICU 68, this function returns the same value as the default MeasureUnit constructor.
     *
     * @return               a MeasureUnit instance
     * @stable ICU 68
     */
    static inline MeasureUnit U_EXPORT2 base() {
        return {};
    }

    /**
     * Returns an instance for percent, or 1/100 of a base unit.
     *
     * Prior to ICU 68, this function returned a NoUnit by value.
     *
     * Since ICU 68, this function returns the same value as MeasureUnit::getPercent().
     *
     * @return               a MeasureUnit instance
     * @stable ICU 68
     */
    static inline MeasureUnit U_EXPORT2 percent() {
        return MeasureUnit::getPercent();
    }

    /**
     * Returns an instance for permille, or 1/1000 of a base unit.
     *
     * Prior to ICU 68, this function returned a NoUnit by value.
     *
     * Since ICU 68, this function returns the same value as MeasureUnit::getPermille().
     *
     * @return               a MeasureUnit instance
     * @stable ICU 68
     */
    static inline MeasureUnit U_EXPORT2 permille() {
        return MeasureUnit::getPermille();
    }
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __NOUNIT_H__
//eof
//
