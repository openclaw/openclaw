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
 * # CategoryHaptic
 *
 * SDL haptic subsystem allows you to control haptic (force feedback) devices.
 *
 * The basic usage is as follows:
 *
 * - Initialize the subsystem (SDL_INIT_HAPTIC).
 * - Open a haptic device.
 * - SDL_HapticOpen() to open from index.
 * - SDL_HapticOpenFromJoystick() to open from an existing joystick.
 * - Create an effect (SDL_HapticEffect).
 * - Upload the effect with SDL_HapticNewEffect().
 * - Run the effect with SDL_HapticRunEffect().
 * - (optional) Free the effect with SDL_HapticDestroyEffect().
 * - Close the haptic device with SDL_HapticClose().
 *
 * Simple rumble example:
 *
 * ```c
 *    SDL_Haptic *haptic;
 *
 *    // Open the device
 *    haptic = SDL_HapticOpen( 0 );
 *    if (haptic == NULL)
 *       return -1;
 *
 *    // Initialize simple rumble
 *    if (SDL_HapticRumbleInit( haptic ) != 0)
 *       return -1;
 *
 *    // Play effect at 50% strength for 2 seconds
 *    if (SDL_HapticRumblePlay( haptic, 0.5, 2000 ) != 0)
 *       return -1;
 *    SDL_Delay( 2000 );
 *
 *    // Clean up
 *    SDL_HapticClose( haptic );
 * ```
 *
 * Complete example:
 *
 * ```c
 * int test_haptic( SDL_Joystick * joystick ) {
 *    SDL_Haptic *haptic;
 *    SDL_HapticEffect effect;
 *    int effect_id;
 *
 *    // Open the device
 *    haptic = SDL_HapticOpenFromJoystick( joystick );
 *    if (haptic == NULL) return -1; // Most likely joystick isn't haptic
 *
 *    // See if it can do sine waves
 *    if ((SDL_HapticQuery(haptic) & SDL_HAPTIC_SINE)==0) {
 *       SDL_HapticClose(haptic); // No sine effect
 *       return -1;
 *    }
 *
 *    // Create the effect
 *    SDL_memset( &effect, 0, sizeof(SDL_HapticEffect) ); // 0 is safe default
 *    effect.type = SDL_HAPTIC_SINE;
 *    effect.periodic.direction.type = SDL_HAPTIC_POLAR; // Polar coordinates
 *    effect.periodic.direction.dir[0] = 18000; // Force comes from south
 *    effect.periodic.period = 1000; // 1000 ms
 *    effect.periodic.magnitude = 20000; // 20000/32767 strength
 *    effect.periodic.length = 5000; // 5 seconds long
 *    effect.periodic.attack_length = 1000; // Takes 1 second to get max strength
 *    effect.periodic.fade_length = 1000; // Takes 1 second to fade away
 *
 *    // Upload the effect
 *    effect_id = SDL_HapticNewEffect( haptic, &effect );
 *
 *    // Test the effect
 *    SDL_HapticRunEffect( haptic, effect_id, 1 );
 *    SDL_Delay( 5000); // Wait for the effect to finish
 *
 *    // We destroy the effect, although closing the device also does this
 *    SDL_HapticDestroyEffect( haptic, effect_id );
 *
 *    // Close the device
 *    SDL_HapticClose(haptic);
 *
 *    return 0; // Success
 * }
 * ```
 */

#ifndef SDL_haptic_h_
#define SDL_haptic_h_

#include "SDL_stdinc.h"
#include "SDL_error.h"
#include "SDL_joystick.h"

#include "begin_code.h"
/* Set up for C function definitions, even when using C++ */
#ifdef __cplusplus
extern "C" {
#endif /* __cplusplus */

/* FIXME: For SDL 2.1, adjust all the magnitude variables to be Uint16 (0xFFFF).
 *
 * At the moment the magnitude variables are mixed between signed/unsigned, and
 * it is also not made clear that ALL of those variables expect a max of 0x7FFF.
 *
 * Some platforms may have higher precision than that (Linux FF, Windows XInput)
 * so we should fix the inconsistency in favor of higher possible precision,
 * adjusting for platforms that use different scales.
 * -flibit
 */

/**
 *  \typedef SDL_Haptic
 *
 *  \brief The haptic structure used to identify an SDL haptic.
 *
 *  \sa SDL_HapticOpen
 *  \sa SDL_HapticOpenFromJoystick
 *  \sa SDL_HapticClose
 */
struct _SDL_Haptic;
typedef struct _SDL_Haptic SDL_Haptic;


/**
 *  \name Haptic features
 *
 *  Different haptic features a device can have.
 */
/* @{ */

/**
 *  \name Haptic effects
 */
/* @{ */

/**
 * Constant effect supported.
 *
 * Constant haptic effect.
 *
 * \sa SDL_HapticCondition
 */
#define SDL_HAPTIC_CONSTANT   (1u<<0)

/**
 * Sine wave effect supported.
 *
 * Periodic haptic effect that simulates sine waves.
 *
 * \sa SDL_HapticPeriodic
 */
#define SDL_HAPTIC_SINE       (1u<<1)

/**
 * Left/Right effect supported.
 *
 * Haptic effect for direct control over high/low frequency motors.
 *
 * \sa SDL_HapticLeftRight
 */
#define SDL_HAPTIC_LEFTRIGHT     (1u<<2)

/* !!! FIXME: put this back when we have more bits in 2.1 */
/* #define SDL_HAPTIC_SQUARE     (1<<2) */

/**
 * Triangle wave effect supported.
 *
 * Periodic haptic effect that simulates triangular waves.
 *
 * \sa SDL_HapticPeriodic
 */
#define SDL_HAPTIC_TRIANGLE   (1u<<3)

/**
 * Sawtoothup wave effect supported.
 *
 * Periodic haptic effect that simulates saw tooth up waves.
 *
 * \sa SDL_HapticPeriodic
 */
#define SDL_HAPTIC_SAWTOOTHUP (1u<<4)

/**
 * Sawtoothdown wave effect supported.
 *
 * Periodic haptic effect that simulates saw tooth down waves.
 *
 * \sa SDL_HapticPeriodic
 */
#define SDL_HAPTIC_SAWTOOTHDOWN (1u<<5)

/**
 * Ramp effect supported.
 *
 * Ramp haptic effect.
 *
 * \sa SDL_HapticRamp
 */
#define SDL_HAPTIC_RAMP       (1u<<6)

/**
 * Spring effect supported - uses axes position.
 *
 * Condition haptic effect that simulates a spring. Effect is based on the
 * axes position.
 *
 * \sa SDL_HapticCondition
 */
#define SDL_HAPTIC_SPRING     (1u<<7)

/**
 * Damper effect supported - uses axes velocity.
 *
 * Condition haptic effect that simulates dampening. Effect is based on the
 * axes velocity.
 *
 * \sa SDL_HapticCondition
 */
#define SDL_HAPTIC_DAMPER     (1u<<8)

/**
 * Inertia effect supported - uses axes acceleration.
 *
 * Condition haptic effect that simulates inertia. Effect is based on the axes
 * acceleration.
 *
 * \sa SDL_HapticCondition
 */
#define SDL_HAPTIC_INERTIA    (1u<<9)

/**
 * Friction effect supported - uses axes movement.
 *
 * Condition haptic effect that simulates friction. Effect is based on the
 * axes movement.
 *
 * \sa SDL_HapticCondition
 */
#define SDL_HAPTIC_FRICTION   (1u<<10)

/**
 * Custom effect is supported.
 *
 * User defined custom haptic effect.
 */
#define SDL_HAPTIC_CUSTOM     (1u<<11)

/* @} *//* Haptic effects */

/* These last few are features the device has, not effects */

/**
 * Device can set global gain.
 *
 * Device supports setting the global gain.
 *
 * \sa SDL_HapticSetGain
 */
#define SDL_HAPTIC_GAIN       (1u<<12)

/**
 * Device can set autocenter.
 *
 * Device supports setting autocenter.
 *
 * \sa SDL_HapticSetAutocenter
 */
#define SDL_HAPTIC_AUTOCENTER (1u<<13)

/**
 * Device can be queried for effect status.
 *
 * Device supports querying effect status.
 *
 * \sa SDL_HapticGetEffectStatus
 */
#define SDL_HAPTIC_STATUS     (1u<<14)

/**
 * Device can be paused.
 *
 * Devices supports being paused.
 *
 * \sa SDL_HapticPause
 * \sa SDL_HapticUnpause
 */
#define SDL_HAPTIC_PAUSE      (1u<<15)


/**
 * \name Direction encodings
 */
/* @{ */

/**
 * Uses polar coordinates for the direction.
 *
 * \sa SDL_HapticDirection
 */
#define SDL_HAPTIC_POLAR      0

/**
 * Uses cartesian coordinates for the direction.
 *
 * \sa SDL_HapticDirection
 */
#define SDL_HAPTIC_CARTESIAN  1

/**
 * Uses spherical coordinates for the direction.
 *
 * \sa SDL_HapticDirection
 */
#define SDL_HAPTIC_SPHERICAL  2

/**
 * Use this value to play an effect on the steering wheel axis.
 *
 * This provides better compatibility across platforms and devices as SDL will
 * guess the correct axis.
 *
 * \sa SDL_HapticDirection
 */
#define SDL_HAPTIC_STEERING_AXIS 3

/* @} *//* Direction encodings */

/* @} *//* Haptic features */

/*
 * Misc defines.
 */

/**
 * Used to play a device an infinite number of times.
 *
 * \sa SDL_HapticRunEffect
 */
#define SDL_HAPTIC_INFINITY   4294967295U


/**
 * Structure that represents a haptic direction.
 *
 * This is the direction where the force comes from, instead of the direction
 * in which the force is exerted.
 *
 * Directions can be specified by:
 *
 * - SDL_HAPTIC_POLAR : Specified by polar coordinates.
 * - SDL_HAPTIC_CARTESIAN : Specified by cartesian coordinates.
 * - SDL_HAPTIC_SPHERICAL : Specified by spherical coordinates.
 *
 * Cardinal directions of the haptic device are relative to the positioning of
 * the device. North is considered to be away from the user.
 *
 * The following diagram represents the cardinal directions:
 *
 * ```
 *                .--.
 *                |__| .-------.
 *                |=.| |.-----.|
 *                |--| ||     ||
 *                |  | |'-----'|
 *                |__|~')_____('
 *                  [ COMPUTER ]
 *
 *
 *                    North (0,-1)
 *                        ^
 *                        |
 *                        |
 *  (-1,0)  West <----[ HAPTIC ]----> East (1,0)
 *                        |
 *                        |
 *                        v
 *                     South (0,1)
 *
 *
 *                     [ USER ]
 *                       \|||/
 *                       (o o)
 *                 ---ooO-(_)-Ooo---
 * ```
 *
 * If type is SDL_HAPTIC_POLAR, direction is encoded by hundredths of a degree
 * starting north and turning clockwise. SDL_HAPTIC_POLAR only uses the first
 * `dir` parameter. The cardinal directions would be:
 *
 * - North: 0 (0 degrees)
 * - East: 9000 (90 degrees)
 * - South: 18000 (180 degrees)
 * - West: 27000 (270 degrees)
 *
 * If type is SDL_HAPTIC_CARTESIAN, direction is encoded by three positions (X
 * axis, Y axis and Z axis (with 3 axes)). SDL_HAPTIC_CARTESIAN uses the first
 * three `dir` parameters. The cardinal directions would be:
 *
 * - North: 0,-1, 0
 * - East: 1, 0, 0
 * - South: 0, 1, 0
 * - West: -1, 0, 0
 *
 * The Z axis represents the height of the effect if supported, otherwise it's
 * unused. In cartesian encoding (1, 2) would be the same as (2, 4), you can
 * use any multiple you want, only the direction matters.
 *
 * If type is SDL_HAPTIC_SPHERICAL, direction is encoded by two rotations. The
 * first two `dir` parameters are used. The `dir` parameters are as follows
 * (all values are in hundredths of degrees):
 *
 * - Degrees from (1, 0) rotated towards (0, 1).
 * - Degrees towards (0, 0, 1) (device needs at least 3 axes).
 *
 * Example of force coming from the south with all encodings (force coming
 * from the south means the user will have to pull the stick to counteract):
 *
 * ```c
 *  SDL_HapticDirection direction;
 *
 *  // Cartesian directions
 *  direction.type = SDL_HAPTIC_CARTESIAN; // Using cartesian direction encoding.
 *  direction.dir[0] = 0; // X position
 *  direction.dir[1] = 1; // Y position
 *  // Assuming the device has 2 axes, we don't need to specify third parameter.
 *
 *  // Polar directions
 *  direction.type = SDL_HAPTIC_POLAR; // We'll be using polar direction encoding.
 *  direction.dir[0] = 18000; // Polar only uses first parameter
 *
 *  // Spherical coordinates
 *  direction.type = SDL_HAPTIC_SPHERICAL; // Spherical encoding
 *  direction.dir[0] = 9000; // Since we only have two axes we don't need more parameters.
 * ```
 *
 * \sa SDL_HAPTIC_POLAR
 * \sa SDL_HAPTIC_CARTESIAN
 * \sa SDL_HAPTIC_SPHERICAL
 * \sa SDL_HAPTIC_STEERING_AXIS
 * \sa SDL_HapticEffect
 * \sa SDL_HapticNumAxes
 */
typedef struct SDL_HapticDirection
{
    Uint8 type;         /**< The type of encoding. */
    Sint32 dir[3];      /**< The encoded direction. */
} SDL_HapticDirection;


/**
 * A structure containing a template for a Constant effect.
 *
 * This struct is exclusively for the SDL_HAPTIC_CONSTANT effect.
 *
 * A constant effect applies a constant force in the specified direction to
 * the joystick.
 *
 * \sa SDL_HAPTIC_CONSTANT
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticConstant
{
    /* Header */
    Uint16 type;            /**< SDL_HAPTIC_CONSTANT */
    SDL_HapticDirection direction;  /**< Direction of the effect. */

    /* Replay */
    Uint32 length;          /**< Duration of the effect. */
    Uint16 delay;           /**< Delay before starting the effect. */

    /* Trigger */
    Uint16 button;          /**< Button that triggers the effect. */
    Uint16 interval;        /**< How soon it can be triggered again after button. */

    /* Constant */
    Sint16 level;           /**< Strength of the constant effect. */

    /* Envelope */
    Uint16 attack_length;   /**< Duration of the attack. */
    Uint16 attack_level;    /**< Level at the start of the attack. */
    Uint16 fade_length;     /**< Duration of the fade. */
    Uint16 fade_level;      /**< Level at the end of the fade. */
} SDL_HapticConstant;

/**
 * A structure containing a template for a Periodic effect.
 *
 * The struct handles the following effects:
 *
 * - SDL_HAPTIC_SINE
 * - SDL_HAPTIC_SQUARE
 * - SDL_HAPTIC_TRIANGLE
 * - SDL_HAPTIC_SAWTOOTHUP
 * - SDL_HAPTIC_SAWTOOTHDOWN
 *
 * A periodic effect consists in a wave-shaped effect that repeats itself over
 * time. The type determines the shape of the wave and the parameters
 * determine the dimensions of the wave.
 *
 * Phase is given by hundredth of a degree meaning that giving the phase a
 * value of 9000 will displace it 25% of its period. Here are sample values:
 *
 * - 0: No phase displacement.
 * - 9000: Displaced 25% of its period.
 * - 18000: Displaced 50% of its period.
 * - 27000: Displaced 75% of its period.
 * - 36000: Displaced 100% of its period, same as 0, but 0 is preferred.
 *
 * Examples:
 *
 * ```
 *   SDL_HAPTIC_SINE
 *     __      __      __      __
 *    /  \    /  \    /  \    /
 *   /    \__/    \__/    \__/
 *
 *   SDL_HAPTIC_SQUARE
 *    __    __    __    __    __
 *   |  |  |  |  |  |  |  |  |  |
 *   |  |__|  |__|  |__|  |__|  |
 *
 *   SDL_HAPTIC_TRIANGLE
 *     /\    /\    /\    /\    /\
 *    /  \  /  \  /  \  /  \  /
 *   /    \/    \/    \/    \/
 *
 *   SDL_HAPTIC_SAWTOOTHUP
 *     /|  /|  /|  /|  /|  /|  /|
 *    / | / | / | / | / | / | / |
 *   /  |/  |/  |/  |/  |/  |/  |
 *
 *   SDL_HAPTIC_SAWTOOTHDOWN
 *   \  |\  |\  |\  |\  |\  |\  |
 *    \ | \ | \ | \ | \ | \ | \ |
 *     \|  \|  \|  \|  \|  \|  \|
 * ```
 *
 * \sa SDL_HAPTIC_SINE
 * \sa SDL_HAPTIC_LEFTRIGHT
 * \sa SDL_HAPTIC_TRIANGLE
 * \sa SDL_HAPTIC_SAWTOOTHUP
 * \sa SDL_HAPTIC_SAWTOOTHDOWN
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticPeriodic
{
    /* Header */
    Uint16 type;        /**< SDL_HAPTIC_SINE, SDL_HAPTIC_LEFTRIGHT,
                             SDL_HAPTIC_TRIANGLE, SDL_HAPTIC_SAWTOOTHUP or
                             SDL_HAPTIC_SAWTOOTHDOWN */
    SDL_HapticDirection direction;  /**< Direction of the effect. */

    /* Replay */
    Uint32 length;      /**< Duration of the effect. */
    Uint16 delay;       /**< Delay before starting the effect. */

    /* Trigger */
    Uint16 button;      /**< Button that triggers the effect. */
    Uint16 interval;    /**< How soon it can be triggered again after button. */

    /* Periodic */
    Uint16 period;      /**< Period of the wave. */
    Sint16 magnitude;   /**< Peak value; if negative, equivalent to 180 degrees extra phase shift. */
    Sint16 offset;      /**< Mean value of the wave. */
    Uint16 phase;       /**< Positive phase shift given by hundredth of a degree. */

    /* Envelope */
    Uint16 attack_length;   /**< Duration of the attack. */
    Uint16 attack_level;    /**< Level at the start of the attack. */
    Uint16 fade_length; /**< Duration of the fade. */
    Uint16 fade_level;  /**< Level at the end of the fade. */
} SDL_HapticPeriodic;

/**
 * A structure containing a template for a Condition effect.
 *
 * The struct handles the following effects:
 *
 * - SDL_HAPTIC_SPRING: Effect based on axes position.
 * - SDL_HAPTIC_DAMPER: Effect based on axes velocity.
 * - SDL_HAPTIC_INERTIA: Effect based on axes acceleration.
 * - SDL_HAPTIC_FRICTION: Effect based on axes movement.
 *
 * Direction is handled by condition internals instead of a direction member.
 * The condition effect specific members have three parameters. The first
 * refers to the X axis, the second refers to the Y axis and the third refers
 * to the Z axis. The right terms refer to the positive side of the axis and
 * the left terms refer to the negative side of the axis. Please refer to the
 * SDL_HapticDirection diagram for which side is positive and which is
 * negative.
 *
 * \sa SDL_HapticDirection
 * \sa SDL_HAPTIC_SPRING
 * \sa SDL_HAPTIC_DAMPER
 * \sa SDL_HAPTIC_INERTIA
 * \sa SDL_HAPTIC_FRICTION
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticCondition
{
    /* Header */
    Uint16 type;            /**< SDL_HAPTIC_SPRING, SDL_HAPTIC_DAMPER,
                                 SDL_HAPTIC_INERTIA or SDL_HAPTIC_FRICTION */
    SDL_HapticDirection direction;  /**< Direction of the effect. */

    /* Replay */
    Uint32 length;          /**< Duration of the effect. */
    Uint16 delay;           /**< Delay before starting the effect. */

    /* Trigger */
    Uint16 button;          /**< Button that triggers the effect. */
    Uint16 interval;        /**< How soon it can be triggered again after button. */

    /* Condition */
    Uint16 right_sat[3];    /**< Level when joystick is to the positive side; max 0xFFFF. */
    Uint16 left_sat[3];     /**< Level when joystick is to the negative side; max 0xFFFF. */
    Sint16 right_coeff[3];  /**< How fast to increase the force towards the positive side. */
    Sint16 left_coeff[3];   /**< How fast to increase the force towards the negative side. */
    Uint16 deadband[3];     /**< Size of the dead zone; max 0xFFFF: whole axis-range when 0-centered. */
    Sint16 center[3];       /**< Position of the dead zone. */
} SDL_HapticCondition;

/**
 * A structure containing a template for a Ramp effect.
 *
 * This struct is exclusively for the SDL_HAPTIC_RAMP effect.
 *
 * The ramp effect starts at start strength and ends at end strength. It
 * augments in linear fashion. If you use attack and fade with a ramp the
 * effects get added to the ramp effect making the effect become quadratic
 * instead of linear.
 *
 * \sa SDL_HAPTIC_RAMP
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticRamp
{
    /* Header */
    Uint16 type;            /**< SDL_HAPTIC_RAMP */
    SDL_HapticDirection direction;  /**< Direction of the effect. */

    /* Replay */
    Uint32 length;          /**< Duration of the effect. */
    Uint16 delay;           /**< Delay before starting the effect. */

    /* Trigger */
    Uint16 button;          /**< Button that triggers the effect. */
    Uint16 interval;        /**< How soon it can be triggered again after button. */

    /* Ramp */
    Sint16 start;           /**< Beginning strength level. */
    Sint16 end;             /**< Ending strength level. */

    /* Envelope */
    Uint16 attack_length;   /**< Duration of the attack. */
    Uint16 attack_level;    /**< Level at the start of the attack. */
    Uint16 fade_length;     /**< Duration of the fade. */
    Uint16 fade_level;      /**< Level at the end of the fade. */
} SDL_HapticRamp;

/**
 * A structure containing a template for a Left/Right effect.
 *
 * This struct is exclusively for the SDL_HAPTIC_LEFTRIGHT effect.
 *
 * The Left/Right effect is used to explicitly control the large and small
 * motors, commonly found in modern game controllers. The small (right) motor
 * is high frequency, and the large (left) motor is low frequency.
 *
 * \sa SDL_HAPTIC_LEFTRIGHT
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticLeftRight
{
    /* Header */
    Uint16 type;            /**< SDL_HAPTIC_LEFTRIGHT */

    /* Replay */
    Uint32 length;          /**< Duration of the effect in milliseconds. */

    /* Rumble */
    Uint16 large_magnitude; /**< Control of the large controller motor. */
    Uint16 small_magnitude; /**< Control of the small controller motor. */
} SDL_HapticLeftRight;

/**
 * A structure containing a template for the SDL_HAPTIC_CUSTOM effect.
 *
 * This struct is exclusively for the SDL_HAPTIC_CUSTOM effect.
 *
 * A custom force feedback effect is much like a periodic effect, where the
 * application can define its exact shape. You will have to allocate the data
 * yourself. Data should consist of channels * samples Uint16 samples.
 *
 * If channels is one, the effect is rotated using the defined direction.
 * Otherwise it uses the samples in data for the different axes.
 *
 * \sa SDL_HAPTIC_CUSTOM
 * \sa SDL_HapticEffect
 */
typedef struct SDL_HapticCustom
{
    /* Header */
    Uint16 type;            /**< SDL_HAPTIC_CUSTOM */
    SDL_HapticDirection direction;  /**< Direction of the effect. */

    /* Replay */
    Uint32 length;          /**< Duration of the effect. */
    Uint16 delay;           /**< Delay before starting the effect. */

    /* Trigger */
    Uint16 button;          /**< Button that triggers the effect. */
    Uint16 interval;        /**< How soon it can be triggered again after button. */

    /* Custom */
    Uint8 channels;         /**< Axes to use, minimum of one. */
    Uint16 period;          /**< Sample periods. */
    Uint16 samples;         /**< Amount of samples. */
    Uint16 *data;           /**< Should contain channels*samples items. */

    /* Envelope */
    Uint16 attack_length;   /**< Duration of the attack. */
    Uint16 attack_level;    /**< Level at the start of the attack. */
    Uint16 fade_length;     /**< Duration of the fade. */
    Uint16 fade_level;      /**< Level at the end of the fade. */
} SDL_HapticCustom;

/**
 * The generic template for any haptic effect.
 *
 * All values max at 32767 (0x7FFF). Signed values also can be negative. Time
 * values unless specified otherwise are in milliseconds.
 *
 * You can also pass SDL_HAPTIC_INFINITY to length instead of a 0-32767 value.
 * Neither delay, interval, attack_length nor fade_length support
 * SDL_HAPTIC_INFINITY. Fade will also not be used since effect never ends.
 *
 * Additionally, the SDL_HAPTIC_RAMP effect does not support a duration of
 * SDL_HAPTIC_INFINITY.
 *
 * Button triggers may not be supported on all devices, it is advised to not
 * use them if possible. Buttons start at index 1 instead of index 0 like the
 * joystick.
 *
 * If both attack_length and fade_level are 0, the envelope is not used,
 * otherwise both values are used.
 *
 * Common parts:
 *
 * ```c
 *  // Replay - All effects have this
 *  Uint32 length;        // Duration of effect (ms).
 *  Uint16 delay;         // Delay before starting effect.
 *
 *  // Trigger - All effects have this
 *  Uint16 button;        // Button that triggers effect.
 *  Uint16 interval;      // How soon before effect can be triggered again.
 *
 *  // Envelope - All effects except condition effects have this
 *  Uint16 attack_length; // Duration of the attack (ms).
 *  Uint16 attack_level;  // Level at the start of the attack.
 *  Uint16 fade_length;   // Duration of the fade out (ms).
 *  Uint16 fade_level;    // Level at the end of the fade.
 * ```
 *
 * Here we have an example of a constant effect evolution in time:
 *
 * ```
 *  Strength
 *  ^
 *  |
 *  |    effect level -->  _________________
 *  |                     /                 \
 *  |                    /                   \
 *  |                   /                     \
 *  |                  /                       \
 *  | attack_level --> |                        \
 *  |                  |                        |  <---  fade_level
 *  |
 *  +--------------------------------------------------> Time
 *                     [--]                 [---]
 *                     attack_length        fade_length
 *
 *  [------------------][-----------------------]
 *  delay               length
 * ```
 *
 * Note either the attack_level or the fade_level may be above the actual
 * effect level.
 *
 * \sa SDL_HapticConstant
 * \sa SDL_HapticPeriodic
 * \sa SDL_HapticCondition
 * \sa SDL_HapticRamp
 * \sa SDL_HapticLeftRight
 * \sa SDL_HapticCustom
 */
typedef union SDL_HapticEffect
{
    /* Common for all force feedback effects */
    Uint16 type;                    /**< Effect type. */
    SDL_HapticConstant constant;    /**< Constant effect. */
    SDL_HapticPeriodic periodic;    /**< Periodic effect. */
    SDL_HapticCondition condition;  /**< Condition effect. */
    SDL_HapticRamp ramp;            /**< Ramp effect. */
    SDL_HapticLeftRight leftright;  /**< Left/Right effect. */
    SDL_HapticCustom custom;        /**< Custom effect. */
} SDL_HapticEffect;


/* Function prototypes */

/**
 * Count the number of haptic devices attached to the system.
 *
 * \returns the number of haptic devices detected on the system or a negative
 *          error code on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticName
 */
extern DECLSPEC int SDLCALL SDL_NumHaptics(void);

/**
 * Get the implementation dependent name of a haptic device.
 *
 * This can be called before any joysticks are opened. If no name can be
 * found, this function returns NULL.
 *
 * \param device_index index of the device to query.
 * \returns the name of the device or NULL on failure; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_NumHaptics
 */
extern DECLSPEC const char *SDLCALL SDL_HapticName(int device_index);

/**
 * Open a haptic device for use.
 *
 * The index passed as an argument refers to the N'th haptic device on this
 * system.
 *
 * When opening a haptic device, its gain will be set to maximum and
 * autocenter will be disabled. To modify these values use SDL_HapticSetGain()
 * and SDL_HapticSetAutocenter().
 *
 * \param device_index index of the device to open.
 * \returns the device identifier or NULL on failure; call SDL_GetError() for
 *          more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticClose
 * \sa SDL_HapticIndex
 * \sa SDL_HapticOpenFromJoystick
 * \sa SDL_HapticOpenFromMouse
 * \sa SDL_HapticPause
 * \sa SDL_HapticSetAutocenter
 * \sa SDL_HapticSetGain
 * \sa SDL_HapticStopAll
 */
extern DECLSPEC SDL_Haptic *SDLCALL SDL_HapticOpen(int device_index);

/**
 * Check if the haptic device at the designated index has been opened.
 *
 * \param device_index the index of the device to query.
 * \returns 1 if it has been opened, 0 if it hasn't or on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticIndex
 * \sa SDL_HapticOpen
 */
extern DECLSPEC int SDLCALL SDL_HapticOpened(int device_index);

/**
 * Get the index of a haptic device.
 *
 * \param haptic the SDL_Haptic device to query.
 * \returns the index of the specified haptic device or a negative error code
 *          on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpen
 * \sa SDL_HapticOpened
 */
extern DECLSPEC int SDLCALL SDL_HapticIndex(SDL_Haptic * haptic);

/**
 * Query whether or not the current mouse has haptic capabilities.
 *
 * \returns SDL_TRUE if the mouse is haptic or SDL_FALSE if it isn't.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpenFromMouse
 */
extern DECLSPEC int SDLCALL SDL_MouseIsHaptic(void);

/**
 * Try to open a haptic device from the current mouse.
 *
 * \returns the haptic device identifier or NULL on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpen
 * \sa SDL_MouseIsHaptic
 */
extern DECLSPEC SDL_Haptic *SDLCALL SDL_HapticOpenFromMouse(void);

/**
 * Query if a joystick has haptic features.
 *
 * \param joystick the SDL_Joystick to test for haptic capabilities.
 * \returns SDL_TRUE if the joystick is haptic, SDL_FALSE if it isn't, or a
 *          negative error code on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpenFromJoystick
 */
extern DECLSPEC int SDLCALL SDL_JoystickIsHaptic(SDL_Joystick * joystick);

/**
 * Open a haptic device for use from a joystick device.
 *
 * You must still close the haptic device separately. It will not be closed
 * with the joystick.
 *
 * When opened from a joystick you should first close the haptic device before
 * closing the joystick device. If not, on some implementations the haptic
 * device will also get unallocated and you'll be unable to use force feedback
 * on that device.
 *
 * \param joystick the SDL_Joystick to create a haptic device from.
 * \returns a valid haptic device identifier on success or NULL on failure;
 *          call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticClose
 * \sa SDL_HapticOpen
 * \sa SDL_JoystickIsHaptic
 */
extern DECLSPEC SDL_Haptic *SDLCALL SDL_HapticOpenFromJoystick(SDL_Joystick *
                                                               joystick);

/**
 * Close a haptic device previously opened with SDL_HapticOpen().
 *
 * \param haptic the SDL_Haptic device to close.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpen
 */
extern DECLSPEC void SDLCALL SDL_HapticClose(SDL_Haptic * haptic);

/**
 * Get the number of effects a haptic device can store.
 *
 * On some platforms this isn't fully supported, and therefore is an
 * approximation. Always check to see if your created effect was actually
 * created and do not rely solely on SDL_HapticNumEffects().
 *
 * \param haptic the SDL_Haptic device to query.
 * \returns the number of effects the haptic device can store or a negative
 *          error code on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticNumEffectsPlaying
 * \sa SDL_HapticQuery
 */
extern DECLSPEC int SDLCALL SDL_HapticNumEffects(SDL_Haptic * haptic);

/**
 * Get the number of effects a haptic device can play at the same time.
 *
 * This is not supported on all platforms, but will always return a value.
 *
 * \param haptic the SDL_Haptic device to query maximum playing effects.
 * \returns the number of effects the haptic device can play at the same time
 *          or a negative error code on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticNumEffects
 * \sa SDL_HapticQuery
 */
extern DECLSPEC int SDLCALL SDL_HapticNumEffectsPlaying(SDL_Haptic * haptic);

/**
 * Get the haptic device's supported features in bitwise manner.
 *
 * \param haptic the SDL_Haptic device to query.
 * \returns a list of supported haptic features in bitwise manner (OR'd), or 0
 *          on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticEffectSupported
 * \sa SDL_HapticNumEffects
 */
extern DECLSPEC unsigned int SDLCALL SDL_HapticQuery(SDL_Haptic * haptic);


/**
 * Get the number of haptic axes the device has.
 *
 * The number of haptic axes might be useful if working with the
 * SDL_HapticDirection effect.
 *
 * \param haptic the SDL_Haptic device to query.
 * \returns the number of axes on success or a negative error code on failure;
 *          call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC int SDLCALL SDL_HapticNumAxes(SDL_Haptic * haptic);

/**
 * Check to see if an effect is supported by a haptic device.
 *
 * \param haptic the SDL_Haptic device to query.
 * \param effect the desired effect to query.
 * \returns SDL_TRUE if effect is supported, SDL_FALSE if it isn't, or a
 *          negative error code on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticNewEffect
 * \sa SDL_HapticQuery
 */
extern DECLSPEC int SDLCALL SDL_HapticEffectSupported(SDL_Haptic * haptic,
                                                      SDL_HapticEffect *
                                                      effect);

/**
 * Create a new haptic effect on a specified device.
 *
 * \param haptic an SDL_Haptic device to create the effect on.
 * \param effect an SDL_HapticEffect structure containing the properties of
 *               the effect to create.
 * \returns the ID of the effect on success or a negative error code on
 *          failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticDestroyEffect
 * \sa SDL_HapticRunEffect
 * \sa SDL_HapticUpdateEffect
 */
extern DECLSPEC int SDLCALL SDL_HapticNewEffect(SDL_Haptic * haptic,
                                                SDL_HapticEffect * effect);

/**
 * Update the properties of an effect.
 *
 * Can be used dynamically, although behavior when dynamically changing
 * direction may be strange. Specifically the effect may re-upload itself and
 * start playing from the start. You also cannot change the type either when
 * running SDL_HapticUpdateEffect().
 *
 * \param haptic the SDL_Haptic device that has the effect.
 * \param effect the identifier of the effect to update.
 * \param data an SDL_HapticEffect structure containing the new effect
 *             properties to use.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticDestroyEffect
 * \sa SDL_HapticNewEffect
 * \sa SDL_HapticRunEffect
 */
extern DECLSPEC int SDLCALL SDL_HapticUpdateEffect(SDL_Haptic * haptic,
                                                   int effect,
                                                   SDL_HapticEffect * data);

/**
 * Run the haptic effect on its associated haptic device.
 *
 * To repeat the effect over and over indefinitely, set `iterations` to
 * `SDL_HAPTIC_INFINITY`. (Repeats the envelope - attack and fade.) To make
 * one instance of the effect last indefinitely (so the effect does not fade),
 * set the effect's `length` in its structure/union to `SDL_HAPTIC_INFINITY`
 * instead.
 *
 * \param haptic the SDL_Haptic device to run the effect on.
 * \param effect the ID of the haptic effect to run.
 * \param iterations the number of iterations to run the effect; use
 *                   `SDL_HAPTIC_INFINITY` to repeat forever.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticDestroyEffect
 * \sa SDL_HapticGetEffectStatus
 * \sa SDL_HapticStopEffect
 */
extern DECLSPEC int SDLCALL SDL_HapticRunEffect(SDL_Haptic * haptic,
                                                int effect,
                                                Uint32 iterations);

/**
 * Stop the haptic effect on its associated haptic device.
 *
 * *
 *
 * \param haptic the SDL_Haptic device to stop the effect on.
 * \param effect the ID of the haptic effect to stop.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticDestroyEffect
 * \sa SDL_HapticRunEffect
 */
extern DECLSPEC int SDLCALL SDL_HapticStopEffect(SDL_Haptic * haptic,
                                                 int effect);

/**
 * Destroy a haptic effect on the device.
 *
 * This will stop the effect if it's running. Effects are automatically
 * destroyed when the device is closed.
 *
 * \param haptic the SDL_Haptic device to destroy the effect on.
 * \param effect the ID of the haptic effect to destroy.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticNewEffect
 */
extern DECLSPEC void SDLCALL SDL_HapticDestroyEffect(SDL_Haptic * haptic,
                                                     int effect);

/**
 * Get the status of the current effect on the specified haptic device.
 *
 * Device must support the SDL_HAPTIC_STATUS feature.
 *
 * \param haptic the SDL_Haptic device to query for the effect status on.
 * \param effect the ID of the haptic effect to query its status.
 * \returns 0 if it isn't playing, 1 if it is playing, or a negative error
 *          code on failure; call SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticRunEffect
 * \sa SDL_HapticStopEffect
 */
extern DECLSPEC int SDLCALL SDL_HapticGetEffectStatus(SDL_Haptic * haptic,
                                                      int effect);

/**
 * Set the global gain of the specified haptic device.
 *
 * Device must support the SDL_HAPTIC_GAIN feature.
 *
 * The user may specify the maximum gain by setting the environment variable
 * `SDL_HAPTIC_GAIN_MAX` which should be between 0 and 100. All calls to
 * SDL_HapticSetGain() will scale linearly using `SDL_HAPTIC_GAIN_MAX` as the
 * maximum.
 *
 * \param haptic the SDL_Haptic device to set the gain on.
 * \param gain value to set the gain to, should be between 0 and 100 (0 -
 *             100).
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticQuery
 */
extern DECLSPEC int SDLCALL SDL_HapticSetGain(SDL_Haptic * haptic, int gain);

/**
 * Set the global autocenter of the device.
 *
 * Autocenter should be between 0 and 100. Setting it to 0 will disable
 * autocentering.
 *
 * Device must support the SDL_HAPTIC_AUTOCENTER feature.
 *
 * \param haptic the SDL_Haptic device to set autocentering on.
 * \param autocenter value to set autocenter to (0-100).
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticQuery
 */
extern DECLSPEC int SDLCALL SDL_HapticSetAutocenter(SDL_Haptic * haptic,
                                                    int autocenter);

/**
 * Pause a haptic device.
 *
 * Device must support the `SDL_HAPTIC_PAUSE` feature. Call
 * SDL_HapticUnpause() to resume playback.
 *
 * Do not modify the effects nor add new ones while the device is paused. That
 * can cause all sorts of weird errors.
 *
 * \param haptic the SDL_Haptic device to pause.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticUnpause
 */
extern DECLSPEC int SDLCALL SDL_HapticPause(SDL_Haptic * haptic);

/**
 * Unpause a haptic device.
 *
 * Call to unpause after SDL_HapticPause().
 *
 * \param haptic the SDL_Haptic device to unpause.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticPause
 */
extern DECLSPEC int SDLCALL SDL_HapticUnpause(SDL_Haptic * haptic);

/**
 * Stop all the currently playing effects on a haptic device.
 *
 * \param haptic the SDL_Haptic device to stop.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 */
extern DECLSPEC int SDLCALL SDL_HapticStopAll(SDL_Haptic * haptic);

/**
 * Check whether rumble is supported on a haptic device.
 *
 * \param haptic haptic device to check for rumble support.
 * \returns SDL_TRUE if effect is supported, SDL_FALSE if it isn't, or a
 *          negative error code on failure; call SDL_GetError() for more
 *          information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticRumbleInit
 * \sa SDL_HapticRumblePlay
 * \sa SDL_HapticRumbleStop
 */
extern DECLSPEC int SDLCALL SDL_HapticRumbleSupported(SDL_Haptic * haptic);

/**
 * Initialize a haptic device for simple rumble playback.
 *
 * \param haptic the haptic device to initialize for simple rumble playback.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticOpen
 * \sa SDL_HapticRumblePlay
 * \sa SDL_HapticRumbleStop
 * \sa SDL_HapticRumbleSupported
 */
extern DECLSPEC int SDLCALL SDL_HapticRumbleInit(SDL_Haptic * haptic);

/**
 * Run a simple rumble effect on a haptic device.
 *
 * \param haptic the haptic device to play the rumble effect on.
 * \param strength strength of the rumble to play as a 0-1 float value.
 * \param length length of the rumble to play in milliseconds.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticRumbleInit
 * \sa SDL_HapticRumbleStop
 * \sa SDL_HapticRumbleSupported
 */
extern DECLSPEC int SDLCALL SDL_HapticRumblePlay(SDL_Haptic * haptic, float strength, Uint32 length );

/**
 * Stop the simple rumble on a haptic device.
 *
 * \param haptic the haptic device to stop the rumble effect on.
 * \returns 0 on success or a negative error code on failure; call
 *          SDL_GetError() for more information.
 *
 * \since This function is available since SDL 2.0.0.
 *
 * \sa SDL_HapticRumbleInit
 * \sa SDL_HapticRumblePlay
 * \sa SDL_HapticRumbleSupported
 */
extern DECLSPEC int SDLCALL SDL_HapticRumbleStop(SDL_Haptic * haptic);

/* Ends C function definitions when using C++ */
#ifdef __cplusplus
}
#endif
#include "close_code.h"

#endif /* SDL_haptic_h_ */

/* vi: set ts=4 sw=4 expandtab: */
