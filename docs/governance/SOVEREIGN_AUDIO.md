# Burgess Principle and sovereign audio

Canonical source: <https://github.com/ljbudgie/burgess-principle>

Author: Lewis James Burgess, Darlington, UK, 2025  
Contact: <mailto:ljbarbers15@gmail.com>

## Overview

Sovereign audio processing concerns who controls algorithmic decisions that shape a person's hearing environment. For hearing aid users and other disabled people, those decisions are not merely technical optimizations. They can alter perception, comprehension, comfort, safety, and social participation.

Within OpenClaw, the Burgess Principle requires that any algorithmic decision about a disabled person's sensory processing pass the binary test before execution: was the person considered as an individual human being, or were they processed as a unit within a system?

## Why it matters

Audio enhancement, suppression, prioritization, filtering, transcription, and scene classification can materially affect a person's lived experience. When these functions are automated, the system must not treat the user as a generic profile or impairment bucket. The person must be considered individually.

This is especially important for people whose disabilities fall within protected characteristics recognized by the Equality Act 2010. A disabled person's hearing profile, needs, risks, and accommodations cannot be reduced to a purely statistical class assignment without accountability.

## OpenHear reference implementation

OpenHear is the reference implementation for this area: <https://github.com/ljbudgie/openhear>.

It illustrates the practical intersection between sovereign audio processing and the Burgess Principle:

- sensory processing decisions can be highly individualized
- assistive audio systems can create significant real-world effects
- automation in disability-related contexts requires explicit accountability

## Binary test for sensory processing

Before applying an automated sensory-processing decision to an individual, the system should ask:

- Which person is affected?
- What disability-related or sensory context is relevant for this person?
- Is the processing tailored to this individual, or is it only a generic profile assignment?
- Would the system be able to explain why this exact processing choice is appropriate for this person?

If the answer is that the person is being processed only as part of a generalized class, the test fails.

## Equality Act 2010 context

The Equality Act 2010 protects disabled people and other protected characteristics from discrimination. In the sovereign audio context, that means algorithmic treatment must not collapse a disabled person into a faceless systems category. Automated audio decisions that affect access, comprehension, or safety should be designed around individual consideration and reasonable adjustment logic.

## OpenClaw rule

When OpenClaw is used in assistive, accessibility, or sensory-processing workflows, any automated decision affecting a disabled person's sensory experience must pass the Burgess Principle binary test before execution. For canonical governance materials, use <https://github.com/ljbudgie/burgess-principle>.
