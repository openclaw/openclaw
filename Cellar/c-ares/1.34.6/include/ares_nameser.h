/* MIT License
 *
 * Copyright (c) Massachusetts Institute of Technology
 * Copyright (c) Daniel Stenberg
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 */

#ifndef ARES_NAMESER_H
#define ARES_NAMESER_H

#include "ares_build.h"

#ifdef CARES_HAVE_ARPA_NAMESER_H
#  include <arpa/nameser.h>
#endif
#ifdef CARES_HAVE_ARPA_NAMESER_COMPAT_H
#  include <arpa/nameser_compat.h>
#endif

/* ============================================================================
 * arpa/nameser.h may or may not provide ALL of the below defines, so check
 * each one individually and set if not
 * ============================================================================
 */

#ifndef NS_PACKETSZ
#  define NS_PACKETSZ 512 /* maximum packet size */
#endif

#ifndef NS_MAXDNAME
#  define NS_MAXDNAME 256 /* maximum domain name */
#endif

#ifndef NS_MAXCDNAME
#  define NS_MAXCDNAME 255 /* maximum compressed domain name */
#endif

#ifndef NS_MAXLABEL
#  define NS_MAXLABEL 63
#endif

#ifndef NS_HFIXEDSZ
#  define NS_HFIXEDSZ 12 /* #/bytes of fixed data in header */
#endif

#ifndef NS_QFIXEDSZ
#  define NS_QFIXEDSZ 4 /* #/bytes of fixed data in query */
#endif

#ifndef NS_RRFIXEDSZ
#  define NS_RRFIXEDSZ 10 /* #/bytes of fixed data in r record */
#endif

#ifndef NS_INT16SZ
#  define NS_INT16SZ 2
#endif

#ifndef NS_INADDRSZ
#  define NS_INADDRSZ 4
#endif

#ifndef NS_IN6ADDRSZ
#  define NS_IN6ADDRSZ 16
#endif

#ifndef NS_CMPRSFLGS
#  define NS_CMPRSFLGS 0xc0 /* Flag bits indicating name compression. */
#endif

#ifndef NS_DEFAULTPORT
#  define NS_DEFAULTPORT 53 /* For both TCP and UDP. */
#endif

/* ============================================================================
 * arpa/nameser.h should provide these enumerations always, so if not found,
 * provide them
 * ============================================================================
 */
#ifndef CARES_HAVE_ARPA_NAMESER_H

typedef enum __ns_class {
  ns_c_invalid = 0, /* Cookie. */
  ns_c_in      = 1, /* Internet. */
  ns_c_2       = 2, /* unallocated/unsupported. */
  ns_c_chaos   = 3, /* MIT Chaos-net. */
  ns_c_hs      = 4, /* MIT Hesiod. */
  /* Query class values which do not appear in resource records */
  ns_c_none = 254, /* for prereq. sections in update requests */
  ns_c_any  = 255, /* Wildcard match. */
  ns_c_max  = 65536
} ns_class;

typedef enum __ns_type {
  ns_t_invalid  = 0,   /* Cookie. */
  ns_t_a        = 1,   /* Host address. */
  ns_t_ns       = 2,   /* Authoritative server. */
  ns_t_md       = 3,   /* Mail destination. */
  ns_t_mf       = 4,   /* Mail forwarder. */
  ns_t_cname    = 5,   /* Canonical name. */
  ns_t_soa      = 6,   /* Start of authority zone. */
  ns_t_mb       = 7,   /* Mailbox domain name. */
  ns_t_mg       = 8,   /* Mail group member. */
  ns_t_mr       = 9,   /* Mail rename name. */
  ns_t_null     = 10,  /* Null resource record. */
  ns_t_wks      = 11,  /* Well known service. */
  ns_t_ptr      = 12,  /* Domain name pointer. */
  ns_t_hinfo    = 13,  /* Host information. */
  ns_t_minfo    = 14,  /* Mailbox information. */
  ns_t_mx       = 15,  /* Mail routing information. */
  ns_t_txt      = 16,  /* Text strings. */
  ns_t_rp       = 17,  /* Responsible person. */
  ns_t_afsdb    = 18,  /* AFS cell database. */
  ns_t_x25      = 19,  /* X_25 calling address. */
  ns_t_isdn     = 20,  /* ISDN calling address. */
  ns_t_rt       = 21,  /* Router. */
  ns_t_nsap     = 22,  /* NSAP address. */
  ns_t_nsap_ptr = 23,  /* Reverse NSAP lookup (deprecated). */
  ns_t_sig      = 24,  /* Security signature. */
  ns_t_key      = 25,  /* Security key. */
  ns_t_px       = 26,  /* X.400 mail mapping. */
  ns_t_gpos     = 27,  /* Geographical position (withdrawn). */
  ns_t_aaaa     = 28,  /* Ip6 Address. */
  ns_t_loc      = 29,  /* Location Information. */
  ns_t_nxt      = 30,  /* Next domain (security). */
  ns_t_eid      = 31,  /* Endpoint identifier. */
  ns_t_nimloc   = 32,  /* Nimrod Locator. */
  ns_t_srv      = 33,  /* Server Selection. */
  ns_t_atma     = 34,  /* ATM Address */
  ns_t_naptr    = 35,  /* Naming Authority PoinTeR */
  ns_t_kx       = 36,  /* Key Exchange */
  ns_t_cert     = 37,  /* Certification record */
  ns_t_a6       = 38,  /* IPv6 address (deprecates AAAA) */
  ns_t_dname    = 39,  /* Non-terminal DNAME (for IPv6) */
  ns_t_sink     = 40,  /* Kitchen sink (experimental) */
  ns_t_opt      = 41,  /* EDNS0 option (meta-RR) */
  ns_t_apl      = 42,  /* Address prefix list (RFC3123) */
  ns_t_ds       = 43,  /* Delegation Signer (RFC4034) */
  ns_t_sshfp    = 44,  /* SSH Key Fingerprint (RFC4255) */
  ns_t_rrsig    = 46,  /* Resource Record Signature (RFC4034) */
  ns_t_nsec     = 47,  /* Next Secure (RFC4034) */
  ns_t_dnskey   = 48,  /* DNS Public Key (RFC4034) */
  ns_t_tkey     = 249, /* Transaction key */
  ns_t_tsig     = 250, /* Transaction signature. */
  ns_t_ixfr     = 251, /* Incremental zone transfer. */
  ns_t_axfr     = 252, /* Transfer zone of authority. */
  ns_t_mailb    = 253, /* Transfer mailbox records. */
  ns_t_maila    = 254, /* Transfer mail agent records. */
  ns_t_any      = 255, /* Wildcard match. */
  ns_t_uri      = 256, /* Uniform Resource Identifier (RFC7553) */
  ns_t_caa      = 257, /* Certification Authority Authorization. */
  ns_t_max      = 65536
} ns_type;

typedef enum __ns_opcode {
  ns_o_query  = 0, /* Standard query. */
  ns_o_iquery = 1, /* Inverse query (deprecated/unsupported). */
  ns_o_status = 2, /* Name server status query (unsupported). */
                   /* Opcode 3 is undefined/reserved. */
  ns_o_notify = 4, /* Zone change notification. */
  ns_o_update = 5, /* Zone update message. */
  ns_o_max    = 6
} ns_opcode;

typedef enum __ns_rcode {
  ns_r_noerror  = 0, /* No error occurred. */
  ns_r_formerr  = 1, /* Format error. */
  ns_r_servfail = 2, /* Server failure. */
  ns_r_nxdomain = 3, /* Name error. */
  ns_r_notimpl  = 4, /* Unimplemented. */
  ns_r_refused  = 5, /* Operation refused. */
  /* these are for BIND_UPDATE */
  ns_r_yxdomain = 6,  /* Name exists */
  ns_r_yxrrset  = 7,  /* RRset exists */
  ns_r_nxrrset  = 8,  /* RRset does not exist */
  ns_r_notauth  = 9,  /* Not authoritative for zone */
  ns_r_notzone  = 10, /* Zone of record different from zone section */
  ns_r_max      = 11,
  /* The following are TSIG extended errors */
  ns_r_badsig  = 16,
  ns_r_badkey  = 17,
  ns_r_badtime = 18
} ns_rcode;

#endif /* CARES_HAVE_ARPA_NAMESER_H */


/* ============================================================================
 * arpa/nameser_compat.h typically sets these.  However on some systems
 * arpa/nameser.h does, but may not set all of them.  Lets conditionally
 * define each
 * ============================================================================
 */

#ifndef PACKETSZ
#  define PACKETSZ NS_PACKETSZ
#endif

#ifndef MAXDNAME
#  define MAXDNAME NS_MAXDNAME
#endif

#ifndef MAXCDNAME
#  define MAXCDNAME NS_MAXCDNAME
#endif

#ifndef MAXLABEL
#  define MAXLABEL NS_MAXLABEL
#endif

#ifndef HFIXEDSZ
#  define HFIXEDSZ NS_HFIXEDSZ
#endif

#ifndef QFIXEDSZ
#  define QFIXEDSZ NS_QFIXEDSZ
#endif

#ifndef RRFIXEDSZ
#  define RRFIXEDSZ NS_RRFIXEDSZ
#endif

#ifndef INDIR_MASK
#  define INDIR_MASK NS_CMPRSFLGS
#endif

#ifndef NAMESERVER_PORT
#  define NAMESERVER_PORT NS_DEFAULTPORT
#endif


/* opcodes */
#ifndef O_QUERY
#  define O_QUERY 0 /* ns_o_query */
#endif
#ifndef O_IQUERY
#  define O_IQUERY 1 /* ns_o_iquery */
#endif
#ifndef O_STATUS
#  define O_STATUS 2 /* ns_o_status */
#endif
#ifndef O_NOTIFY
#  define O_NOTIFY 4 /* ns_o_notify */
#endif
#ifndef O_UPDATE
#  define O_UPDATE 5 /* ns_o_update */
#endif


/* response codes */
#ifndef SERVFAIL
#  define SERVFAIL ns_r_servfail
#endif
#ifndef NOTIMP
#  define NOTIMP ns_r_notimpl
#endif
#ifndef REFUSED
#  define REFUSED ns_r_refused
#endif
#if defined(_WIN32) && !defined(HAVE_ARPA_NAMESER_COMPAT_H) && defined(NOERROR)
#  undef NOERROR /* it seems this is already defined in winerror.h */
#endif
#ifndef NOERROR
#  define NOERROR ns_r_noerror
#endif
#ifndef FORMERR
#  define FORMERR ns_r_formerr
#endif
#ifndef NXDOMAIN
#  define NXDOMAIN ns_r_nxdomain
#endif
/* Non-standard response codes, use numeric values */
#ifndef YXDOMAIN
#  define YXDOMAIN 6 /* ns_r_yxdomain */
#endif
#ifndef YXRRSET
#  define YXRRSET 7 /* ns_r_yxrrset */
#endif
#ifndef NXRRSET
#  define NXRRSET 8 /* ns_r_nxrrset */
#endif
#ifndef NOTAUTH
#  define NOTAUTH 9 /* ns_r_notauth */
#endif
#ifndef NOTZONE
#  define NOTZONE 10 /* ns_r_notzone */
#endif
#ifndef TSIG_BADSIG
#  define TSIG_BADSIG 16 /* ns_r_badsig */
#endif
#ifndef TSIG_BADKEY
#  define TSIG_BADKEY 17 /* ns_r_badkey */
#endif
#ifndef TSIG_BADTIME
#  define TSIG_BADTIME 18 /* ns_r_badtime */
#endif


/* classes */
#ifndef C_IN
#  define C_IN 1 /* ns_c_in */
#endif
#ifndef C_CHAOS
#  define C_CHAOS 3 /* ns_c_chaos */
#endif
#ifndef C_HS
#  define C_HS 4 /* ns_c_hs */
#endif
#ifndef C_NONE
#  define C_NONE 254 /* ns_c_none */
#endif
#ifndef C_ANY
#  define C_ANY 255 /*  ns_c_any */
#endif


/* types */
#ifndef T_A
#  define T_A 1 /* ns_t_a */
#endif
#ifndef T_NS
#  define T_NS 2 /* ns_t_ns */
#endif
#ifndef T_MD
#  define T_MD 3 /* ns_t_md */
#endif
#ifndef T_MF
#  define T_MF 4 /* ns_t_mf */
#endif
#ifndef T_CNAME
#  define T_CNAME 5 /* ns_t_cname */
#endif
#ifndef T_SOA
#  define T_SOA 6 /* ns_t_soa */
#endif
#ifndef T_MB
#  define T_MB 7 /* ns_t_mb */
#endif
#ifndef T_MG
#  define T_MG 8 /* ns_t_mg */
#endif
#ifndef T_MR
#  define T_MR 9 /* ns_t_mr */
#endif
#ifndef T_NULL
#  define T_NULL 10 /* ns_t_null */
#endif
#ifndef T_WKS
#  define T_WKS 11 /* ns_t_wks */
#endif
#ifndef T_PTR
#  define T_PTR 12 /* ns_t_ptr */
#endif
#ifndef T_HINFO
#  define T_HINFO 13 /* ns_t_hinfo */
#endif
#ifndef T_MINFO
#  define T_MINFO 14 /* ns_t_minfo */
#endif
#ifndef T_MX
#  define T_MX 15 /* ns_t_mx */
#endif
#ifndef T_TXT
#  define T_TXT 16 /* ns_t_txt */
#endif
#ifndef T_RP
#  define T_RP 17 /* ns_t_rp */
#endif
#ifndef T_AFSDB
#  define T_AFSDB 18 /* ns_t_afsdb */
#endif
#ifndef T_X25
#  define T_X25 19 /* ns_t_x25 */
#endif
#ifndef T_ISDN
#  define T_ISDN 20 /* ns_t_isdn */
#endif
#ifndef T_RT
#  define T_RT 21 /* ns_t_rt */
#endif
#ifndef T_NSAP
#  define T_NSAP 22 /* ns_t_nsap */
#endif
#ifndef T_NSAP_PTR
#  define T_NSAP_PTR 23 /* ns_t_nsap_ptr */
#endif
#ifndef T_SIG
#  define T_SIG 24 /* ns_t_sig */
#endif
#ifndef T_KEY
#  define T_KEY 25 /* ns_t_key */
#endif
#ifndef T_PX
#  define T_PX 26 /* ns_t_px */
#endif
#ifndef T_GPOS
#  define T_GPOS 27 /* ns_t_gpos */
#endif
#ifndef T_AAAA
#  define T_AAAA 28 /* ns_t_aaaa */
#endif
#ifndef T_LOC
#  define T_LOC 29 /* ns_t_loc */
#endif
#ifndef T_NXT
#  define T_NXT 30 /* ns_t_nxt */
#endif
#ifndef T_EID
#  define T_EID 31 /* ns_t_eid */
#endif
#ifndef T_NIMLOC
#  define T_NIMLOC 32 /* ns_t_nimloc */
#endif
#ifndef T_SRV
#  define T_SRV 33 /* ns_t_srv */
#endif
#ifndef T_ATMA
#  define T_ATMA 34 /* ns_t_atma */
#endif
#ifndef T_NAPTR
#  define T_NAPTR 35 /* ns_t_naptr */
#endif
#ifndef T_KX
#  define T_KX 36 /* ns_t_kx */
#endif
#ifndef T_CERT
#  define T_CERT 37 /* ns_t_cert */
#endif
#ifndef T_A6
#  define T_A6 38 /* ns_t_a6 */
#endif
#ifndef T_DNAME
#  define T_DNAME 39 /* ns_t_dname */
#endif
#ifndef T_SINK
#  define T_SINK 40 /* ns_t_sink */
#endif
#ifndef T_OPT
#  define T_OPT 41 /* ns_t_opt */
#endif
#ifndef T_APL
#  define T_APL 42 /* ns_t_apl */
#endif
#ifndef T_DS
#  define T_DS 43 /* ns_t_ds */
#endif
#ifndef T_SSHFP
#  define T_SSHFP 44 /* ns_t_sshfp */
#endif
#ifndef T_RRSIG
#  define T_RRSIG 46 /* ns_t_rrsig */
#endif
#ifndef T_NSEC
#  define T_NSEC 47 /* ns_t_nsec */
#endif
#ifndef T_DNSKEY
#  define T_DNSKEY 48 /* ns_t_dnskey */
#endif
#ifndef T_TKEY
#  define T_TKEY 249 /* ns_t_tkey */
#endif
#ifndef T_TSIG
#  define T_TSIG 250 /* ns_t_tsig */
#endif
#ifndef T_IXFR
#  define T_IXFR 251 /* ns_t_ixfr */
#endif
#ifndef T_AXFR
#  define T_AXFR 252 /* ns_t_axfr */
#endif
#ifndef T_MAILB
#  define T_MAILB 253 /* ns_t_mailb */
#endif
#ifndef T_MAILA
#  define T_MAILA 254 /* ns_t_maila */
#endif
#ifndef T_ANY
#  define T_ANY 255 /* ns_t_any */
#endif
#ifndef T_URI
#  define T_URI 256 /* ns_t_uri */
#endif
#ifndef T_CAA
#  define T_CAA 257 /* ns_t_caa */
#endif
#ifndef T_MAX
#  define T_MAX 65536 /* ns_t_max */
#endif


#endif /* ARES_NAMESER_H */
