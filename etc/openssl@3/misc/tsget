#!/usr/bin/env perl
# Copyright 2002-2018 The OpenSSL Project Authors. All Rights Reserved.
# Copyright (c) 2002 The OpenTSA Project. All rights reserved.
#
# Licensed under the Apache License 2.0 (the "License").  You may not use
# this file except in compliance with the License.  You can obtain a copy
# in the file LICENSE in the source distribution or at
# https://www.openssl.org/source/license.html

use strict;
use IO::Handle;
use Getopt::Std;
use File::Basename;
use WWW::Curl::Easy;

use vars qw(%options);

# Callback for reading the body.
sub read_body {
    my ($maxlength, $state) = @_;
    my $return_data = "";
    my $data_len = length ${$state->{data}};
    if ($state->{bytes} < $data_len) {
        $data_len = $data_len - $state->{bytes};
        $data_len = $maxlength if $data_len > $maxlength;
        $return_data = substr ${$state->{data}}, $state->{bytes}, $data_len;
        $state->{bytes} += $data_len;
    }
    return $return_data;
}

# Callback for writing the body into a variable.
sub write_body {
    my ($data, $pointer) = @_;
    ${$pointer} .= $data;
    return length($data);
}

# Initialise a new Curl object.
sub create_curl {
    my $url = shift;

    # Create Curl object.
    my $curl = WWW::Curl::Easy::new();

    # Error-handling related options.
    $curl->setopt(CURLOPT_VERBOSE, 1) if $options{d};
    $curl->setopt(CURLOPT_FAILONERROR, 1);
    $curl->setopt(CURLOPT_USERAGENT,
        "OpenTSA tsget.pl/openssl-3.6.1");

    # Options for POST method.
    $curl->setopt(CURLOPT_UPLOAD, 1);
    $curl->setopt(CURLOPT_CUSTOMREQUEST, "POST");
    $curl->setopt(CURLOPT_HTTPHEADER,
        ["Content-Type: application/timestamp-query",
        "Accept: application/timestamp-reply,application/timestamp-response"]);
    $curl->setopt(CURLOPT_READFUNCTION, \&read_body);
    $curl->setopt(CURLOPT_HEADERFUNCTION, sub { return length($_[0]); });

    # Options for getting the result.
    $curl->setopt(CURLOPT_WRITEFUNCTION, \&write_body);

    # SSL related options.
    $curl->setopt(CURLOPT_SSLKEYTYPE, "PEM");
    $curl->setopt(CURLOPT_SSL_VERIFYPEER, 1);    # Verify server's certificate.
    $curl->setopt(CURLOPT_SSL_VERIFYHOST, 2);    # Check server's CN.
    $curl->setopt(CURLOPT_SSLKEY, $options{k}) if defined($options{k});
    $curl->setopt(CURLOPT_SSLKEYPASSWD, $options{p}) if defined($options{p});
    $curl->setopt(CURLOPT_SSLCERT, $options{c}) if defined($options{c});
    $curl->setopt(CURLOPT_CAINFO, $options{C}) if defined($options{C});
    $curl->setopt(CURLOPT_CAPATH, $options{P}) if defined($options{P});
    $curl->setopt(CURLOPT_RANDOM_FILE, $options{r}) if defined($options{r});
    $curl->setopt(CURLOPT_EGDSOCKET, $options{g}) if defined($options{g});

    # Setting destination.
    $curl->setopt(CURLOPT_URL, $url);

    return $curl;
}

# Send a request and returns the body back.
sub get_timestamp {
    my $curl = shift;
    my $body = shift;
    my $ts_body;
    local $::error_buf;

    # Error-handling related options.
    $curl->setopt(CURLOPT_ERRORBUFFER, "::error_buf");

    # Options for POST method.
    $curl->setopt(CURLOPT_INFILE, {data => $body, bytes => 0});
    $curl->setopt(CURLOPT_INFILESIZE, length(${$body}));

    # Options for getting the result.
    $curl->setopt(CURLOPT_FILE, \$ts_body);

    # Send the request...
    my $error_code = $curl->perform();
    my $error_string;
    if ($error_code != 0) {
        my $http_code = $curl->getinfo(CURLINFO_HTTP_CODE);
        $error_string = "could not get timestamp";
        $error_string .= ", http code: $http_code" unless $http_code == 0;
        $error_string .= ", curl code: $error_code";
        $error_string .= " ($::error_buf)" if defined($::error_buf);
    } else {
        my $ct = $curl->getinfo(CURLINFO_CONTENT_TYPE);
        if (lc($ct) ne "application/timestamp-reply"
            && lc($ct) ne "application/timestamp-response") {
            $error_string = "unexpected content type returned: $ct";
        }
    }
    return ($ts_body, $error_string);

}

# Print usage information and exists.
sub usage {

    print STDERR "usage: $0 -h <server_url> [-e <extension>] [-o <output>] ";
    print STDERR "[-v] [-d] [-k <private_key.pem>] [-p <key_password>] ";
    print STDERR "[-c <client_cert.pem>] [-C <CA_certs.pem>] [-P <CA_path>] ";
    print STDERR "[-r <file:file...>] [-g <EGD_socket>] [<request>]...\n";
    exit 1;
}

# ----------------------------------------------------------------------
#   Main program
# ----------------------------------------------------------------------

# Getting command-line options (default comes from TSGET environment variable).
my $getopt_arg =  "h:e:o:vdk:p:c:C:P:r:g:";
if (exists $ENV{TSGET}) {
    my @old_argv = @ARGV;
    @ARGV = split /\s+/, $ENV{TSGET};
    getopts($getopt_arg, \%options) or usage;
    @ARGV = @old_argv;
}
getopts($getopt_arg, \%options) or usage;

# Checking argument consistency.
if (!exists($options{h}) || (@ARGV == 0 && !exists($options{o}))
    || (@ARGV > 1 && exists($options{o}))) {
    print STDERR "Inconsistent command line options.\n";
    usage;
}
# Setting defaults.
@ARGV = ("-") unless @ARGV != 0;
$options{e} = ".tsr" unless defined($options{e});

# Processing requests.
my $curl = create_curl $options{h};
undef $/;   # For reading whole files.
REQUEST: foreach (@ARGV) {
    my $input = $_;
    my ($base, $path) = fileparse($input, '\.[^.]*');
    my $output_base = $base . $options{e};
    my $output = defined($options{o}) ? $options{o} : $path . $output_base;

    STDERR->printflush("$input: ") if $options{v};
    # Read request.
    my $body;
    if ($input eq "-") {
        # Read the request from STDIN;
        $body = <STDIN>;
    } else {
        # Read the request from file.
        open INPUT, "<" . $input
            or warn("$input: could not open input file: $!\n"), next REQUEST;
        $body = <INPUT>;
        close INPUT
            or warn("$input: could not close input file: $!\n"), next REQUEST;
    }

    # Send request.
    STDERR->printflush("sending request") if $options{v};

    my ($ts_body, $error) = get_timestamp $curl, \$body;
    if (defined($error)) {
        die "$input: fatal error: $error\n";
    }
    STDERR->printflush(", reply received") if $options{v};

    # Write response.
    if ($output eq "-") {
        # Write to STDOUT.
        print $ts_body;
    } else {
        # Write to file.
        open OUTPUT, ">", $output
            or warn("$output: could not open output file: $!\n"), next REQUEST;
        print OUTPUT $ts_body;
        close OUTPUT
            or warn("$output: could not close output file: $!\n"), next REQUEST;
    }
    STDERR->printflush(", $output written.\n") if $options{v};
}
$curl->cleanup();
