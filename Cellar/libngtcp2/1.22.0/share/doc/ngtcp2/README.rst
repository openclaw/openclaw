ngtcp2
======

"Call it TCP/2.  One More Time."

ngtcp2 project is an effort to implement `RFC9000
<https://datatracker.ietf.org/doc/html/rfc9000>`_ QUIC protocol.

Documentation
-------------

`Online documentation <https://nghttp2.org/ngtcp2/>`_ is available.

Public test server
------------------

The following endpoints are available to try out ngtcp2
implementation:

- https://nghttp2.org:4433
- https://nghttp2.org:4434 (requires address validation token)
- https://nghttp2.org (powered by `nghttpx
  <https://nghttp2.org/documentation/nghttpx.1.html>`_)

  This endpoints sends Alt-Svc header field to clients if it is
  accessed via HTTP/1.1 or HTTP/2 to tell them that HTTP/3 is
  available at UDP 443.

Requirements
------------

The libngtcp2 C library itself does not depend on any external
libraries.  The example client, and server are written in C++23, and
should compile with the modern C++ compilers (e.g., clang >= 19, or
gcc >= 15).

The following packages are required to configure the build system:

- pkg-config >= 0.20
- autoconf
- automake
- autotools-dev
- libtool

To build sources under the examples directory, libev and nghttp3 are
required:

- libev
- `nghttp3 <https://github.com/ngtcp2/nghttp3>`_ for HTTP/3

To enable `TLS Certificate Compression
<https://datatracker.ietf.org/doc/html/rfc8879>`_ in bsslclient and
bsslserver (BoringSSL (aws-lc) examples client and server), the
following library is required:

- libbrotli-dev >= 1.0.9

ngtcp2 crypto helper library, and client and server under examples
directory require at least one of the following TLS backends:

- `quictls
  <https://github.com/quictls/openssl/tree/OpenSSL_1_1_1w+quic>`_
  (deprecated)
- GnuTLS >= 3.7.5
- BoringSSL (commit 664a985707470a62f436cca862ccec9524c561ca);
  or aws-lc >= 1.39.0
- Picotls (commit b84869f41414b6d0148db7728f1cf12f5b544874)
- wolfSSL >= 5.5.0
- LibreSSL >= v3.9.2
- OpenSSL >= 3.5.0 (experimental)

Before building from git
------------------------

When build from git, run the following command to pull submodules:

.. code-block:: shell

   $ git submodule update --init

Build with wolfSSL
------------------

.. code-block:: shell

   $ git clone --depth 1 -b v5.9.0-stable https://github.com/wolfSSL/wolfssl
   $ cd wolfssl
   $ autoreconf -i
   $ # For wolfSSL < v5.6.6, append --enable-quic.
   $ ./configure --prefix=$PWD/build \
       --enable-all --enable-aesni --enable-harden --enable-keylog-export \
       --disable-ech --enable-mlkem
   $ make -j$(nproc)
   $ make install
   $ cd ..
   $ git clone --recursive https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only
   $ make -j$(nproc) check
   $ make install
   $ cd ..
   $ git clone --recursive https://github.com/ngtcp2/ngtcp2
   $ cd ngtcp2
   $ autoreconf -i
   $ # For Mac users who have installed libev with MacPorts, append
   $ # LIBEV_CFLAGS="-I/opt/local/include" LIBEV_LIBS="-L/opt/local/lib -lev"
   $ ./configure PKG_CONFIG_PATH=$PWD/../wolfssl/build/lib/pkgconfig:$PWD/../nghttp3/build/lib/pkgconfig \
       --with-wolfssl
   $ make -j$(nproc) check

Build with BoringSSL
--------------------

.. code-block:: shell

   $ git clone https://boringssl.googlesource.com/boringssl
   $ cd boringssl
   $ git checkout 664a985707470a62f436cca862ccec9524c561ca
   $ cmake -B build -DCMAKE_POSITION_INDEPENDENT_CODE=ON
   $ make -j$(nproc) -C build
   $ cd ..
   $ git clone --recursive https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only
   $ make -j$(nproc) check
   $ make install
   $ cd ..
   $ git clone --recursive  https://github.com/ngtcp2/ngtcp2
   $ cd ngtcp2
   $ autoreconf -i
   $ # For Mac users who have installed libev with MacPorts, append
   $ # LIBEV_CFLAGS="-I/opt/local/include" LIBEV_LIBS="-L/opt/local/lib -lev"
   $ ./configure PKG_CONFIG_PATH=$PWD/../nghttp3/build/lib/pkgconfig \
       BORINGSSL_LIBS="-L$PWD/../boringssl/build -lssl -lcrypto" \
       BORINGSSL_CFLAGS="-I$PWD/../boringssl/include" \
       --with-boringssl
   $ make -j$(nproc) check

Build with aws-lc
-----------------

.. code-block:: shell

   $ git clone --depth 1 -b v1.71.0 https://github.com/aws/aws-lc
   $ cd aws-lc
   $ cmake -B build -DDISABLE_GO=ON
   $ make -j$(nproc) -C build
   $ cd ..
   $ git clone --recursive https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only
   $ make -j$(nproc) check
   $ make install
   $ cd ..
   $ git clone --recursive  https://github.com/ngtcp2/ngtcp2
   $ cd ngtcp2
   $ autoreconf -i
   $ # For Mac users who have installed libev with MacPorts, append
   $ # LIBEV_CFLAGS="-I/opt/local/include" LIBEV_LIBS="-L/opt/local/lib -lev"
   $ ./configure PKG_CONFIG_PATH=$PWD/../nghttp3/build/lib/pkgconfig \
       BORINGSSL_CFLAGS="-I$PWD/../aws-lc/include" \
       BORINGSSL_LIBS="-L$PWD/../aws-lc/build/ssl -lssl -L$PWD/../aws-lc/build/crypto -lcrypto" \
       --with-boringssl
   $ make -j$(nproc) check

Build with libressl
-----------------

.. code-block:: shell

   $ LIBRESSL_VERSION=v4.2.1
   $ git clone --depth 1 -b $LIBRESSL_VERSION https://github.com/libressl/portable.git libressl
   $ cd libressl
   $ # Workaround autogen.sh failure
   $ export LIBRESSL_GIT_OPTIONS="-b libressl-$LIBRESSL_VERSION"
   $ ./autogen.sh
   $ ./configure --prefix=$PWD/build
   $ make -j$(nproc) install
   $ cd ..
   $ git clone --recursive https://github.com/ngtcp2/nghttp3
   $ cd nghttp3
   $ autoreconf -i
   $ ./configure --prefix=$PWD/build --enable-lib-only
   $ make -j$(nproc) check
   $ make install
   $ cd ..
   $ git clone --recursive  https://github.com/ngtcp2/ngtcp2
   $ cd ngtcp2
   $ autoreconf -i
   $ # For Mac users who have installed libev with MacPorts, append
   $ # LIBEV_CFLAGS="-I/opt/homebrew/Cellar/libev/4.33/include" LIBEV_LIBS="-L/opt/homebrew/Cellar/libev/4.33/lib -lev"
   $ ./configure PKG_CONFIG_PATH=$PWD/../nghttp3/build/lib/pkgconfig:$PWD/../libressl/build/lib/pkgconfig
   $ make -j$(nproc) check

Client/Server
-------------

After successful build, the client and server executable should be
found under examples directory.  They talk HTTP/3.

Client
~~~~~~

.. code-block:: shell

   $ examples/wsslclient [OPTIONS] <HOST> <PORT> [<URI>...]

The notable options are:

- ``-d``, ``--data=<PATH>``: Read data from <PATH> and send it to a
  peer.

Server
~~~~~~

.. code-block:: shell

   $ examples/wsslserver [OPTIONS] <ADDR> <PORT> <PRIVATE_KEY_FILE> <CERTIFICATE_FILE>

The notable options are:

- ``-V``, ``--validate-addr``: Enforce stateless address validation.

H09wsslclient/H09wsslserver
---------------------------

There are h09wsslclient and h09wsslserver which speak HTTP/0.9.  They
are written just for `quic-interop-runner
<https://github.com/marten-seemann/quic-interop-runner>`_.  They share
the basic functionalities with HTTP/3 client and server but have less
functions (e.g., h09wsslclient does not have a capability to send
request body, and h09wsslserver does not understand numeric request
path, like /1000).

Resumption and 0-RTT
--------------------

In order to resume a session, a session ticket, and a transport
parameters must be fetched from server.  First, run
examples/wsslclient with --session-file, and --tp-file options which
specify a path to session ticket, and transport parameter files
respectively to save them locally.

Once these files are available, run examples/wsslclient with the same
arguments again.  You will see that session is resumed in your log if
resumption succeeds.  Resuming session makes server's first Handshake
packet pretty small because it does not send its certificates.

To send 0-RTT data, after making sure that resumption works, use -d
option to specify a file which contains data to send.

Token (Not something included in Retry packet)
----------------------------------------------

QUIC server might send a token to client after connection has been
established.  Client can send this token in subsequent connection to
the server.  Server verifies the token and if it succeeds, the address
validation completes and lifts some restrictions on server which might
speed up transfer.  In order to save and/or load a token,
use --token-file option of examples/wsslclient.  The given file is
overwritten if it already exists when storing a token.

Crypto helper library
---------------------

In order to make TLS stack integration less painful, we provide a
crypto helper library which offers the basic crypto operations.

The header file exists under crypto/includes/ngtcp2 directory.

Each library file is built for a particular TLS backend.  The
available crypto helper libraries are:

- libngtcp2_crypto_quictls: Use quictls as TLS backend (deprecated)
- libngtcp2_crypto_libressl: Use libressl as TLS backend
- libngtcp2_crypto_gnutls: Use GnuTLS as TLS backend
- libngtcp2_crypto_boringssl: Use BoringSSL and aws-lc as TLS backend
- libngtcp2_crypto_picotls: Use Picotls as TLS backend
- libngtcp2_crypto_wolfssl: Use wolfSSL as TLS backend
- libngtcp2_crypto_ossl: Use OpenSSL as TLS backend (experimental)

Because BoringSSL and Picotls are an unversioned product, we only
tested their particular revision.  See Requirements section above.

We use Picotls with OpenSSL as crypto backend.

libngtcp2_crypto_ossl has some restrictions for its use because
OpenSSL QUIC TLS API requires us to keep crypto data in tact until it
says that they are no longer used.  It also requires us to keep
transport parameter buffer.  This extra book keeping is just done for
a couple of TLS messages exchanged during handshake and a couple of
session tickets after handshake.  If you absolutely need to use
OpenSSL backend, your application must make sure that:

- Keep `ngtcp2_conn` alive until ``SSL`` object is freed by
  ``SSL_free``; or
- Call ``SSL_set_app_data(ssl, NULL)`` before calling ``SSL_free``

If you cannot make sure neither of them, it is a good time to migrate
your application to the other alternative (e.g., wolfSSL, aws-lc).

libngtcp2_crypto_quictls, libngtcp2_crypto_libressl and
libngtcp2_crypto_ossl cannot be built at the same time.

Although libressl has its own library libngtcp2_crypto_libressl, an
application should include `ngtcp2/ngtcp2_crypto_quictls.h`.  There is
no `ngtcp2/ngtcp2_crypto_libressl.h`.

The examples directory contains client and server that are linked to
those crypto helper libraries and TLS backends.  They are only built
if their corresponding crypto helper library is built:

- qtlsclient: quictls(libressl) client
- qtlsserver: quictls(libressl) server
- gtlsclient: GnuTLS client
- gtlsserver: GnuTLS server
- bsslclient: BoringSSL(aws-lc) client
- bsslserver: BoringSSL(aws-lc) server
- ptlsclient: Picotls client
- ptlsserver: Picotls server
- wsslclient: wolfSSL client
- wsslserver: wolfSSL server
- osslclient: OpenSSL client
- osslserver: OpenSSL server

QUIC protocol extensions
-------------------------

The library implements the following QUIC protocol extensions:

- `An Unreliable Datagram Extension to QUIC
  <https://datatracker.ietf.org/doc/html/rfc9221>`_
- `Greasing the QUIC Bit
  <https://datatracker.ietf.org/doc/html/rfc9287>`_
- `Compatible Version Negotiation for QUIC
  <https://datatracker.ietf.org/doc/html/rfc9368>`_
- `QUIC Version 2
  <https://datatracker.ietf.org/doc/html/rfc9369>`_

Configuring Wireshark for QUIC
------------------------------

`Wireshark <https://www.wireshark.org/download.html>`_ can be configured to
analyze QUIC traffic using the following steps:

1. Set *SSLKEYLOGFILE* environment variable:

   .. code-block:: shell

      $ export SSLKEYLOGFILE=quic_keylog_file

2. Set the port that QUIC uses

   Go to *Preferences->Protocols->QUIC* and set the port the program
   listens to.  In the case of the example application this would be
   the port specified on the command line.

3. Set Pre-Master-Secret logfile

   Go to *Preferences->Protocols->TLS* and set the *Pre-Master-Secret
   log file* to the same value that was specified for *SSLKEYLOGFILE*.

4. Choose the correct network interface for capturing

   Make sure you choose the correct network interface for
   capturing. For example, if using localhost choose the *loopback*
   network interface on macos.

5. Create a filter

   Create A filter for the udp.port and set the port to the port the
   application is listening to. For example:

   .. code-block:: text

      udp.port == 7777

License
-------

The MIT License

Copyright (c) 2016 ngtcp2 contributors
