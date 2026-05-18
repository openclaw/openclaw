#!/bin/bash

ACCESS_TOKEN=$(bash "$(dirname "$0")/outlook-token.sh" get)

API="https://graph.microsoft.com/v1.0/me"

case "$1" in
    get-profile)
        QUERY="$2"
        if [ -z "$QUERY" ]; then
            echo "Usage: outlook-lookup.sh get-profile <name-or-email>"
            exit 1
        fi

        curl -s -G "https://graph.microsoft.com/v1.0/users" \
            --data-urlencode "\$search=\"displayName:$QUERY\"" \
            --data-urlencode "\$select=displayName,mail,jobTitle,department,officeLocation,businessPhones" \
            --data-urlencode "\$top=5" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "ConsistencyLevel: eventual" | jq 'if .value then (.value[] | {
                name: .displayName,
                email: .mail,
                title: .jobTitle,
                department: .department,
                office: .officeLocation,
                phone: .businessPhones[0]
            }) else {error: .error.message} end'
        ;;

    get-user-profile)
        curl -s "https://graph.microsoft.com/v1.0/me?\$select=displayName,mail,userPrincipalName" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            | jq 'if .error then .error else {name: .displayName, email: (.mail // .userPrincipalName), mail: .mail, userPrincipalName: .userPrincipalName} end'
        ;;

    designation)
        QUERY="$2"
        if [ -z "$QUERY" ]; then
            echo "Usage: outlook-lookup.sh designation <job-title>"
            exit 1
        fi

        curl -s -G "https://graph.microsoft.com/v1.0/users" \
            --data-urlencode "\$search=\"jobTitle:$QUERY\"" \
            --data-urlencode "\$select=displayName,mail,jobTitle,department,officeLocation,businessPhones" \
            --data-urlencode "\$top=10" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "ConsistencyLevel: eventual" || jq 'if .value then (.value[] | {
                name: .displayName,
                email: .mail,
                title: .jobTitle,
                department: .department,
                office: .officeLocation,
                phone: .businessPhones[0]
            }) else {error: .error.message} end'
        ;;

    *)
        echo "Usage: outlook-lookup.sh <command> [args]"
        echo ""
        echo "LOOKUP:"
        echo "  get-profile <name-or-email>    - Look up a person's details"
        echo "  designation <designation>      - Look up a person's details using their designation"
        ;;

esac