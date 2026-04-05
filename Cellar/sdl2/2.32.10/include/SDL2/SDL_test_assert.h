/*
  Simple DirectMedia Layer
  Copyright (C) 1997-2025 Sam Lantinga <slouken@libsdl.org>

  This software is provided 'as-is', without any express or implied
  warranty.  In no event will the authors be held liable for any damages
  arising from the use of this software.

  Permission is granted to anyone to use this software for any purpose,
  including commercial applications, and to alter it and redistribute it
  freely, subject to the following restrictions:

  1. The origin of this software must not be misrepresented; you must not
     claim that you wrote the original software. If you use this software
     in a product, an acknowledgment in the product documentation would be
     appreciated but is not required.
  2. Altered source versions must be plainly marked as such, and must not be
     misrepresented as being the original software.
  3. This notice may not be removed or altered from any source distribution.
*/

/*
 *  \file SDL_test_assert.h
 *
 *  Include file for SDL test framework.
 *
 *  This code is a part of the SDL2_test library, not the main SDL library.
 */

/*
 *
 * Assert API for test code and test cases
 *
 */

#ifndef SDL_test_assert_h_
#define SDL_test_assert_h_

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif

/*
 * \brief Fails the assert.
 */
#define ASSERT_FAIL     0

/*
 * \brief Passes the assert.
 */
#define ASSERT_PASS     1

/*
 * \brief Assert that logs and break execution flow on failures.
 *
 * \param assertCondition Evaluated condition or variable to assert; fail (==0) or pass (!=0).
 * \param assertDescription Message to log with the assert describing it.
 */
void SDLTest_Assert(int assertCondition, SDL_PRINTF_FORMAT_STRING const char *assertDescription, ...) SDL_PRINTF_VARARG_FUNC(2);

/*
 * \brief Assert for test cases that logs but does not break execution flow on failures. Updates assertion counters.
 *
 * \param assertCondition Evaluated condition or variable to assert; fail (==0) or pass (!=0).
 * \param assertDescription Message to log with the assert describing it.
 *
 * \returns the assertCondition so it can be used to externally to break execution flow if desired.
 */
int SDLTest_AssertCheck(int assertCondition, SDL_PRINTF_FORMAT_STRING const char *assertDescription, ...) SDL_PRINTF_VARARG_FUNC(2);

/*
 * \brief Explicitly pass without checking an assertion condition. Updates assertion counter.
 *
 * \param assertDescription Message to log with the assert describing it.
 */
void SDLTest_AssertPass(SDL_PRINTF_FORMAT_STRING const char *assertDescription, ...) SDL_PRINTF_VARARG_FUNC(1);

/*
 * \brief Resets the assert summary counters to zero.
 */
void SDLTest_ResetAssertSummary(void);

/*
 * \brief Logs summary of all assertions (total, pass, fail) since last reset as INFO or ERROR.
 */
void SDLTest_LogAssertSummary(void);


/*
 * \brief Converts the current assert summary state to a test result.
 *
 * \returns TEST_RESULT_PASSED, TEST_RESULT_FAILED, or TEST_RESULT_NO_ASSERT
 */
int SDLTest_AssertSummaryToTestResult(void);

#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_test_assert_h_ */

/* vi: set ts=4 sw=4 expandtab: */
