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

/**
 * # CategorySensor
 *
 * Include file for SDL sensor event handling
 */

#ifndef SDL_sensor_h_
#define SDL_sensor_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
/* *INDENT-OFF* */
extern "C" {
/* *INDENT-ON* */
#endif

/**
 *  \brief SDL_sensor.h
 *
 *  In order to use these functions, SDL_Init() must have been called
 *  with the SDL_INIT_SENSOR flag.  This causes SDL to scan the system
 *  for sensors, and load appropriate drivers.
 */

struct _SDL_Sensor;
typedef struct _SDL_Sensor SDL_Sensor;

/**
 * This is a unique ID for a sensor for the time it is connected to the
 * system, and is never reused for the lifetime of the application.
 *
 * The ID value starts at 0 and increments from there. The value -1 is an
 * invalid ID.
 */
typedef Sint32 SDL_SensorID;

/**
 * The different sensors defined by SDL.
 *
 * Additional sensors may be available, using platform dependent semantics.
 *
 * Here are the additional Android sensors:
 *
 * https://developer.android.com/reference/android/hardware/SensorEvent.html#values
 *
 * Accelerometer sensor notes:
 *
 * The accelerometer returns the current acceleration in SI meters per second
 * squared. This measurement includes the force of gravity, so a device at
 * rest will have an value of SDL_STANDARD_GRAVITY away from the center of the
 * earth, which is a positive Y value.
 *
 * - `values[0]`: Acceleration on the x axis
 * - `values[1]`: Acceleration on the y axis
 * - `values[2]`: Acceleration on the z axis
 *
 * For phones and tablets held in natural orientation and game controllers
 * held in front of you, the axes are defined as follows:
 *
 * - -X ... +X : left ... right
 * - -Y ... +Y : bottom ... top
 * - -Z ... +Z : farther ... closer
 *
 * The accelerometer axis data is not changed when the device is rotated.
 *
 * Gyroscope sensor notes:
 *
 * The gyroscope returns the current rate of rotation in radians per second.
 * The rotation is positive in the counter-clockwise direction. That is, an
 * observer looking from a positive location on one of the axes would see
 * positive rotation on that axis when it appeared to be rotating
 * counter-clockwise.
 *
 * - `values[0]`: Angular speed around the x axis (pitch)
 * - `values[1]`: Angular speed around the y axis (yaw)
 * - `values[2]`: Angular speed around the z axis (roll)
 *
 * For phones and tablets held in natural orientation and game controllers
 * held in front of you, the axes are defined as follows:
 *
 * - -X ... +X : left ... right
 * - -Y ... +Y : bottom ... top
 * - -Z ... +Z : farther ... closer
 *
 * The gyroscope axis data is not changed when the device is rotated.
 *
 * \sa SDL_GetDisplayOrientation
 */
typedef enum SDL_SensorType
{
    SDL_SENSOR_INVALID = -1,    /**< Returned for an invalid sensor */
    SDL_SENSOR_UNKNOWN,         /**< Unknown sensor type */
    SDL_SENSOR_ACCEL,           /**< Accelerometer */
    SDL_SENSOR_GYRO,            /**< Gyroscope */
    SDL_SENSOR_ACCEL_L,         /**< Accelerometer for left Joy-Con controller and Wii nunchuk */
    SDL_SENSOR_GYRO_L,          /**< Gyroscope for left Joy-Con controller */
    SDL_SENSOR_ACCEL_R,         /**< Accelerometer for right Joy-Con controller */
    SDL_SENSOR_GYRO_R           /**< Gyroscope for right Joy-Con controller */
} SDL_SensorType;

/**
 * A constant to represent standard gravity for accelerometer sensors.
 *
 * The accelerometer returns the current acceleration in SI meters per second
 * squared. This measurement includes the force of gravity, so a device at
 * rest will have an value of SDL_STANDARD_GRAVITY away from the center of the
 * earth, which is a positive Y value.
 */
#define SDL_STANDARD_GRAVITY    9.80665f

/* Function prototypes */

/**
 * Locking for multi-threaded access to the sensor API
 *
 * If you are using the sensor API or handling events from multiple threads
 * you should use these locking functions to protect access to the sensors.
 *
 * In particular, you are guaranteed that the sensor list won't change, so the
 * API functions that take a sensor index will be valid, and sensor events
 * will not be delivered.
 *
 * \since This function is available since SDL 2.0.14.
 */
extern DECLSPEC void SDLCALL SDL_LockSensors(void);
extern DECLSPEC void SDLCALL SDL_UnlockSensors(void);

/**
 * Count the number of sensors attached to the system right now.
 *
 * \returns the number of sensors detected.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC int SDLCALL SDL_NumSensors(void);

/**
 * Get the implementation dependent name of a sensor.
 *
 * \param device_index The sensor to obtain name from.
 * \returns the sensor name, or NULL if `device_index` is out of range.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC const char *SDLCALL SDL_SensorGetDeviceName(int device_index);

/**
 * Get the type of a sensor.
 *
 * \param device_index The sensor to get the type from.
 * \returns the SDL_SensorType, or `SDL_SENSOR_INVALID` if `device_index` is
 *          out of range.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_SensorType SDLCALL SDL_SensorGetDeviceType(int device_index);

/**
 * Get the platform dependent type of a sensor.
 *
 * \param device_index The sensor to check.
 * \returns the sensor platform dependent type, or -1 if `device_index` is out
 *          of range.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC int SDLCALL SDL_SensorGetDeviceNonPortableType(int device_index);

/**
 * Get the instance ID of a sensor.
 *
 * \param device_index The sensor to get instance id from.
 * \returns the sensor instance ID, or -1 if `device_index` is out of range.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_SensorID SDLCALL SDL_SensorGetDeviceInstanceID(int device_index);

/**
 * Open a sensor for use.
 *
 * \param device_index The sensor to open.
 * \returns an SDL_Sensor sensor object, or NULL if an error occurred.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_Sensor *SDLCALL SDL_SensorOpen(int device_index);

/**
 * Return the SDL_Sensor associated with an instance id.
 *
 * \param instance_id The sensor from instance id.
 * \returns an SDL_Sensor object.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_Sensor *SDLCALL SDL_SensorFromInstanceID(SDL_SensorID instance_id);

/**
 * Get the implementation dependent name of a sensor
 *
 * \param sensor The SDL_Sensor object.
 * \returns the sensor name, or NULL if `sensor` is NULL.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC const char *SDLCALL SDL_SensorGetName(SDL_Sensor *sensor);

/**
 * Get the type of a sensor.
 *
 * \param sensor The SDL_Sensor object to inspect.
 * \returns the SDL_SensorType type, or `SDL_SENSOR_INVALID` if `sensor` is
 *          NULL.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_SensorType SDLCALL SDL_SensorGetType(SDL_Sensor *sensor);

/**
 * Get the platform dependent type of a sensor.
 *
 * \param sensor The SDL_Sensor object to inspect.
 * \returns the sensor platform dependent type, or -1 if `sensor` is NULL.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC int SDLCALL SDL_SensorGetNonPortableType(SDL_Sensor *sensor);

/**
 * Get the instance ID of a sensor.
 *
 * \param sensor The SDL_Sensor object to inspect.
 * \returns the sensor instance ID, or -1 if `sensor` is NULL.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC SDL_SensorID SDLCALL SDL_SensorGetInstanceID(SDL_Sensor *sensor);

/**
 * Get the current state of an opened sensor.
 *
 * The number of values and interpretation of the data is sensor dependent.
 *
 * \param sensor The SDL_Sensor object to query.
 * \param data A pointer filled with the current sensor state.
 * \param num_values The number of values to write to data.
 * \returns 0 or -1 if an error occurred.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC int SDLCALL SDL_SensorGetData(SDL_Sensor *sensor, float *data, int num_values);

/**
 * Get the current state of an opened sensor with the timestamp of the last
 * update.
 *
 * The number of values and interpretation of the data is sensor dependent.
 *
 * \param sensor The SDL_Sensor object to query.
 * \param timestamp A pointer filled with the timestamp in microseconds of the
 *                  current sensor reading if available, or 0 if not.
 * \param data A pointer filled with the current sensor state.
 * \param num_values The number of values to write to data.
 * \returns 0 or -1 if an error occurred.
 *
 * \since This function is available since SDL 2.26.0.
 */
extern DECLSPEC int SDLCALL SDL_SensorGetDataWithTimestamp(SDL_Sensor *sensor, Uint64 *timestamp, float *data, int num_values);

/**
 * Close a sensor previously opened with SDL_SensorOpen().
 *
 * \param sensor The SDL_Sensor object to close.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC void SDLCALL SDL_SensorClose(SDL_Sensor *sensor);

/**
 * Update the current state of the open sensors.
 *
 * This is called automatically by the event loop if sensor events are
 * enabled.
 *
 * This needs to be called from the thread that initialized the sensor
 * subsystem.
 *
 * \since This function is available since SDL 2.0.9.
 */
extern DECLSPEC void SDLCALL SDL_SensorUpdate(void);


/* Ends C function definitions when using C++ */
#ifdef __cplusplus
/* *INDENT-OFF* */
}
/* *INDENT-ON* */
#endif
#include "close_code.h"

#endif /* SDL_sensor_h_ */

/* vi: set ts=4 sw=4 expandtab: */
