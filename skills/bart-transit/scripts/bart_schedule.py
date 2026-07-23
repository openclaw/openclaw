#!/usr/bin/env python3
"""Small BART schedule helper for OpenClaw skill use.

Requires BART_API_KEY or HTK_BART_API_KEY in the environment for live schedules.
"""
import argparse
import datetime as dt
import difflib
import json
import os
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

STATIONS_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'references', 'stations.json')
API_BASE = 'https://api.bart.gov/api/sched.aspx'


def load_stations():
    with open(STATIONS_PATH, 'r', encoding='utf-8') as f:
        return json.load(f)


def resolve_station(query, stations):
    q = query.strip().lower()
    if not q:
        raise SystemExit('empty station query')
    for code, info in stations.items():
        if q == code.lower() or q == info['name'].lower() or q in [a.lower() for a in info.get('aliases', [])]:
            return code
    choices = []
    owner = {}
    for code, info in stations.items():
        labels = [code, info['name']] + info.get('aliases', [])
        for label in labels:
            key = label.lower()
            choices.append(key)
            owner[key] = code
    matches = difflib.get_close_matches(q, choices, n=3, cutoff=0.58)
    if len(matches) == 1:
        return owner[matches[0]]
    if matches:
        print('Ambiguous station. Did you mean: ' + ', '.join(f"{stations[owner[m]]['name']} ({owner[m]})" for m in matches), file=sys.stderr)
        raise SystemExit(2)
    print('No BART station match for: ' + query, file=sys.stderr)
    raise SystemExit(2)


def api_key():
    key = os.environ.get('BART_API_KEY') or os.environ.get('HTK_BART_API_KEY')
    if not key:
        raise SystemExit('Missing BART_API_KEY or HTK_BART_API_KEY')
    return key


def fetch_depart(orig, dest, count=5, time='now', date='today'):
    before = 0
    after = max(0, count - 1)
    params = {
        'cmd': 'depart',
        'orig': orig,
        'dest': dest,
        'time': time,
        'date': date,
        'b': str(before),
        'a': str(after),
        'l': '0',
        'key': api_key(),
    }
    url = API_BASE + '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=20) as resp:
        root = ET.fromstring(resp.read())
    trips = []
    for trip in root.findall('.//trip')[:count]:
        trips.append({
            'origin': trip.attrib.get('origin'),
            'destination': trip.attrib.get('destination'),
            'depart': trip.attrib.get('origTimeMin'),
            'arrive': trip.attrib.get('destTimeMin'),
            'duration_min': trip.attrib.get('tripTime'),
        })
    return trips


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    depart = sub.add_parser('depart')
    depart.add_argument('--orig', required=True)
    depart.add_argument('--dest', required=True)
    depart.add_argument('--count', type=int, default=5)
    depart.add_argument('--time', default='now')
    depart.add_argument('--date', default='today')
    args = p.parse_args()
    stations = load_stations()
    if args.cmd == 'depart':
        orig = resolve_station(args.orig, stations)
        dest = resolve_station(args.dest, stations)
        result = {
            'origin': {'code': orig, 'name': stations[orig]['name']},
            'destination': {'code': dest, 'name': stations[dest]['name']},
            'trips': fetch_depart(orig, dest, count=args.count, time=args.time, date=args.date),
        }
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
