== Opus audio codec ==

Opus is a codec for interactive speech and audio transmission over the Internet.

  Opus can handle a wide range of interactive audio applications, including
Voice over IP, videoconferencing, in-game  chat, and even remote live music
performances. It can scale from low bit-rate narrowband speech to very high
quality stereo music.

  Opus, when coupled with an appropriate container format, is also suitable
for non-realtime  stored-file applications such as music distribution, game
soundtracks, portable music players, jukeboxes, and other applications that
have historically used high latency formats such as MP3, AAC, or Vorbis.

                    Opus is specified by IETF RFC 6716:
                    https://tools.ietf.org/html/rfc6716

  The Opus format and this implementation of it are subject to the royalty-
free patent and copyright licenses specified in the file COPYING.

This package implements a shared library for encoding and decoding raw Opus
bitstreams. Raw Opus bitstreams should be used over RTP according to
 https://tools.ietf.org/html/rfc7587

The package also includes a number of test tools used for testing the
correct operation of the library. The bitstreams read/written by these
tools should not be used for Opus file distribution: They include
additional debugging data and cannot support seeking.

Opus stored in files should use the Ogg encapsulation for Opus which is
described at:
 https://tools.ietf.org/html/rfc7845

An opus-tools package is available which provides encoding and decoding of
Ogg encapsulated Opus files and includes a number of useful features.

Opus-tools can be found at:
 https://gitlab.xiph.org/xiph/opus-tools.git
or on the main Opus website:
 https://opus-codec.org/

== Deep Learning and Opus ==

Lossy networks continue to be a challenge for real-time communications.
While the original implementation of Opus provides an excellent packet loss
concealment mechanism, the team has continued to advance the methodology used
to improve audio quality in challenge network environments.

In Opus 1.5, we added a deep learning based redundancy encoder that enhances
audio in lossy networks by embedding one second of recovery data in the padding
data of each packet. The underlying algorithm behind encoding and decoding the
recovery data is called the deep redundancy (DRED) algorithm. By leveraging
the padding data within the packet, Opus 1.5 is fully backward compatible with
prior revisions of Opus. Please see the README under the "dnn" subdirectory to
understand DRED.

DRED was developed by a team that Amazon Web Services initially sponsored,
who open-sourced the implementation as well as began the
standardization process at the IETF:
  https://datatracker.ietf.org/doc/draft-ietf-mlcodec-opus-extension/
The license behind Opus or the intellectual property position of Opus does
not change with Opus 1.5.

== Compiling libopus ==

To build from a distribution tarball, you only need to do the following:

    % ./configure
    % make

To build from the git repository, the following steps are necessary:

0) Set up a development environment:

On an Ubuntu or Debian family Linux distribution:

    % sudo apt-get install git autoconf automake libtool gcc make

On a Fedora/Redhat based Linux:

    % sudo dnf install git autoconf automake libtool gcc make

Or for older Redhat/Centos Linux releases:

    % sudo yum install git autoconf automake libtool gcc make

On Apple macOS, install Xcode and brew.sh, then in the Terminal enter:

    % brew install autoconf automake libtool

1) Clone the repository:

    % git clone https://gitlab.xiph.org/xiph/opus.git
    % cd opus

2) Compiling the source

    % ./autogen.sh
    % ./configure
    % make

On x86, it's a good idea to use a -march= option that allows the use of AVX2.

3) Install the codec libraries (optional)

    % sudo make install

Once you have compiled the codec, there will be a opus_demo executable
in the top directory.

Usage: opus_demo [-e] <application> <sampling rate (Hz)> <channels (1/2)>
         <bits per second> [options] <input> <output>
       opus_demo -d <sampling rate (Hz)> <channels (1/2)> [options]
         <input> <output>

mode: voip | audio | restricted-lowdelay
options:
  -e                : only runs the encoder (output the bit-stream)
  -d                : only runs the decoder (reads the bit-stream as input)
  -cbr              : enable constant bitrate; default: variable bitrate
  -cvbr             : enable constrained variable bitrate; default:
                      unconstrained
  -bandwidth <NB|MB|WB|SWB|FB>
                    : audio bandwidth (from narrowband to fullband);
                      default: sampling rate
  -framesize <2.5|5|10|20|40|60>
                    : frame size in ms; default: 20
  -max_payload <bytes>
                    : maximum payload size in bytes, default: 1024
  -complexity <comp>
                    : complexity, 0 (lowest) ... 10 (highest); default: 10
  -inbandfec        : enable SILK inband FEC
  -forcemono        : force mono encoding, even for stereo input
  -dtx              : enable SILK DTX
  -loss <perc>      : simulate packet loss, in percent (0-100); default: 0

input and output are little-endian signed 16-bit PCM files or opus
bitstreams with simple opus_demo proprietary framing.

== Testing ==

This package includes a collection of automated unit and system tests
which SHOULD be run after compiling the package especially the first
time it is run on a new platform.

To run the integrated tests:

    % make check

There is also collection of standard test vectors which are not
included in this package for size reasons but can be obtained from:
https://opus-codec.org/docs/opus_testvectors-rfc8251.tar.gz

To run compare the code to these test vectors:

    % curl -OL https://opus-codec.org/docs/opus_testvectors-rfc8251.tar.gz
    % tar -zxf opus_testvectors-rfc8251.tar.gz
    % ./tests/run_vectors.sh ./ opus_newvectors 48000

== Compiling libopus for Windows and alternative build systems ==

See cmake/README.md or meson/README.md.

== Portability notes ==

This implementation uses floating-point by default but can be compiled to
use only fixed-point arithmetic by setting --enable-fixed-point (if using
autoconf) or by defining the FIXED_POINT macro (if building manually).
The fixed point implementation has somewhat lower audio quality and is
slower on platforms with fast FPUs, it is normally only used in embedded
environments.

The implementation can be compiled with either a C89 or a C99 compiler.
While it does not rely on any _undefined behavior_ as defined by C89 or
C99, it relies on common _implementation-defined behavior_ for two's
complement architectures:

o Right shifts of negative values are consistent with two's
  complement arithmetic, so that a>>b is equivalent to
  floor(a/(2^b)),

o For conversion to a signed integer of N bits, the value is reduced
  modulo 2^N to be within range of the type,

o The result of integer division of a negative value is truncated
  towards zero, and

o The compiler provides a 64-bit integer type (a C99 requirement
  which is supported by most C89 compilers).
