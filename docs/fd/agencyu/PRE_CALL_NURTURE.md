# Pre-Call Nurture

## Overview

Automated nurture sequence triggered by booking creation.
Reduces no-shows and increases close rate by pre-selling with proof + framing.

## Booking → Nurture Timeline

| Offset        | Asset Type      | Channel    | Description                          |
|---------------|-----------------|------------|--------------------------------------|
| +0h (booked)  | Confirmation     | SMS + Email| Booking confirmation with prep link  |
| +2h           | VSL              | Email      | Value-packed video sales letter       |
| +24h          | Case Study #1    | Email      | Most relevant result for their niche  |
| +48h          | Social Proof     | SMS        | Quick testimonial + reminder          |
| -24h (call)   | Reminder         | SMS + Email| "Looking forward to tomorrow" + agenda|
| -2h (call)    | Final Reminder   | SMS        | "See you in 2 hours" + meeting link   |

Offsets are relative to booking creation (+) or call time (-).

## Assets Matrix

| Segment          | VSL              | Case Study 1      | Case Study 2      |
|------------------|------------------|--------------------|--------------------|
| Starter (< $5k)  | Generic intro    | Small biz win      | ROI-focused        |
| Growth ($5k–$20k)| Scaling story    | Niche-specific     | Process-focused    |
| Scale ($20k+)    | Enterprise proof | Large account win  | Systems-focused    |

Segments determined by `revenue:<tier>` tag on the contact.

## No-Show Rescue Sequence

Triggered when a booking becomes a no-show:

| Offset (from missed call) | Action                              |
|---------------------------|-------------------------------------|
| +15min                    | SMS: "Looks like we missed each other — want to rebook?" |
| +2h                       | Email: Rebook link + bonus case study |
| +24h                      | SMS: Final attempt with scarcity     |
| +48h                      | Tag as `status:no_show_cold`, stop   |

## Stop Rules

Nurture actions are cancelled if any of these conditions are met:
- Contact status becomes `closed_won` or `closed_lost`
- Booking is cancelled
- Contact requests opt-out
- Contact books a new call (restart with new timeline)
- Global cooldown is active

## GHL Integration

Nurture actions are executed as GHL workflow enrollments.
OpenClaw schedules the actions and enforces stop rules; GHL handles actual delivery.

## Safety

- All nurture actions respect `DRY_RUN` / `SAFE_MODE` — simulated by default
- Rate limited per contact (max 3 touches / 24h)
- Global cooldown integration via `is_cooldown_active()`
- Every action audit-logged with correlation_id
