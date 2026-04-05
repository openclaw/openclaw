/*
* Copyright(c) 2019 Intel Corporation
*
* This source code is subject to the terms of the BSD 2 Clause License and
* the Alliance for Open Media Patent License 1.0. If the BSD 2 Clause License
* was not distributed with this source code in the LICENSE file, you can
* obtain it at https://www.aomedia.org/license/software-license. If the Alliance for Open
* Media Patent License 1.0 was not distributed with this source code in the
* PATENTS file, you can obtain it at https://www.aomedia.org/license/patent-license.
*/

#ifndef EbSvtAv1ErrorCodes_h
#define EbSvtAv1ErrorCodes_h

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

#define CHECK_REPORT_ERROR(cond, app_callback_ptr, errorCode)                         \
    if (!(cond)) {                                                                    \
        (app_callback_ptr)->error_handler(((app_callback_ptr)->handle), (errorCode)); \
        while (1) {}                                                                  \
    }
#define CHECK_REPORT_ERROR_NC(app_callback_ptr, errorCode)                            \
    {                                                                                 \
        (app_callback_ptr)->error_handler(((app_callback_ptr)->handle), (errorCode)); \
        while (1) {}                                                                  \
    }

typedef enum ENCODER_ERROR_CODES {

    EB_ENC_CL_ERROR2 = 0x0501,

    EB_ENC_EC_ERROR2  = 0x0701,
    EB_ENC_EC_ERROR29 = 0x0722,
    EB_ENC_RC_ERROR2  = 0x1401,
    //EB_ENC_PM_ERRORS                  = 0x1300,

    EB_ENC_PM_ERROR1    = 0x1301,
    EB_ENC_PM_ERROR4    = 0x1304,
    EB_ENC_PM_ERROR5    = 0x1305,
    EB_ENC_PM_ERROR6    = 0x1306,
    EB_ENC_PM_ERROR7    = 0x1307,
    EB_ENC_PM_ERROR8    = 0x1308,
    EB_ENC_PM_ERROR9    = 0x1309,
    EB_ENC_PM_ERROR10   = 0x130a,
    EB_ENC_ROB_OF_ERROR = 0x1601,
    //EB_ENC_PD_ERRORS                  = 0x2100,
    EB_ENC_PD_ERROR1 = 0x2100,
    EB_ENC_PD_ERROR2 = 0x2101,
    EB_ENC_PD_ERROR3 = 0x2102,
    EB_ENC_PD_ERROR5 = 0x2104,
    EB_ENC_PD_ERROR7 = 0x2106,
    EB_ENC_PD_ERROR8 = 0x2107,
} ENCODER_ERROR_CODES;

#ifdef __cplusplus
}
#endif // __cplusplus

#endif // EbSvtAv1ErrorCodes_h
